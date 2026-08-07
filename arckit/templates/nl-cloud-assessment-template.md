# NL Sovereign Cloud Assessment (Rijksbreed Cloudbeleid 2026)

> **Template Origin**: Community Overlay (nl-gov) | **ArcKit Version**:
> [VERSION] | **Command**: `/arckit:nl-cloud`

> ⚠️ **NOT OFFICIALLY VALIDATED.** This is a community jurisdiction overlay
> template for the ArcKit swamp port. It is not reviewed or endorsed by
> tractorjuice/arc-kit upstream, EZK, BZK, the OBDO, CIO Rijk, or CISO Rijk.
> **Verify every citation against the primary source before relying on this
> document for a real procurement or continuity decision.** This document
> records an assessment; it does not replace the mandatory §3.3 melding to CISO
> Rijk, nor any aanwijzing CISO Rijk may issue.

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time to _partials/document-control-nl.md (default for the nl-gov profile), or _partials/document-control-uk.md / _partials/document-control-uae.md based on plugin userConfig classification_scheme + governance_framework. See _partials/RENDERING.md (when present). -->

## Revision History

| Version   | Date   | Author    | Changes                                          | Approved By | Approval Date |
| --------- | ------ | --------- | ------------------------------------------------ | ----------- | ------------- |
| [VERSION] | [DATE] | ArcKit AI | Initial creation from `/arckit:nl-cloud` command | [PENDING]   | [PENDING]     |

## Legal & Policy Grounding

| Instrument                                                                              | Date / Reference                                      | Relevance                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Herziening rijksbreed cloudbeleid 2026**                                              | Ministerie van EZK, **3 juli 2026**, definitief       | Primary instrument for this document. Applies to all Rijksoverheid **except Hoge Colleges van Staat**; **Defensie is exempt**.                           |
| **OBDO Cloud definities en begrippenlijst**                                             | Approved **16 april 2026**                            | Authoritative definitions for terms used in the cloud policy and in this template (e.g. "materieel cloudgebruik"). Defer to it over any paraphrase here. |
| **TBB systematiek / VIRBI 2025**                                                        | See `nl-tbb-classification-template.md`               | Mandatory upstream input — §5 below cannot be completed without it.                                                                                      |
| **Cyberbeveiligingswet (Cbw, NIS2) / Wet weerbaarheid kritieke entiteiten (Wwke, CER)** | Eerste Kamer 7 July 2026, in force **15 August 2026** | Entity-type facts (`isCbwEssentialEntity`, `isWwkeEntity`) required by §5's eligibility call.                                                            |

**Related instruments** (named in the approved plan's source research; **not
detailed in this template beyond title + date** — read the primary source before
citing their content):

- Notitie: Verkenning Overheidsbrede Soevereine Clouddiensten (NDS
  Cloudprogramma, v1.0, 11 juni 2026, definitief) — see
  `eu-sovereignty-assessment-template.md` §1.
- Nationaal beleid voor de Nederlandse cloudmarkt — 3 juli 2026 (a **second,
  distinct** cloud instrument published the same day as the Rijksbreed
  cloudbeleid revision; do not conflate the two).
- Nederlandse Digitaliseringsstrategie — 4 juli 2025.
- Visie Digitale Autonomie en Soevereiniteit van de Overheid.
- Agenda DOSA (Kamerstukken II 2023/24, 36 259, nr. 23).
- Cybersecuritybeeld Nederland (CSBN) 2025.

## Document Purpose

[Brief description: this document determines whether the system/service in scope
is subject to the Rijksbreed cloudbeleid 2026, whether its intended public-cloud
use is allowed/conditional/discouraged/prohibited, and what follow-on
obligations (melding, exit plan, gekend-gebruik register) apply.]

---

## Executive Summary

**System/service assessed**: [SYSTEM/SERVICE NAME]

**Materieel publiek cloudgebruik?** (§4.1): [Ja/Nee — see §2]

**Eligibility verdict** (§5, `nlCloudEligibility`): **[ALLOWED / CONDITIONAL /
DISCOURAGED / PROHIBITED]**

**Clauses cited by the verdict**: [List, or "none"]

**Transition status**: [New use — assess before procurement / Existing use —
within the 4-year transition period, exit plan due within 12 months of this
policy's effective date]

**CISO Rijk melding required** (§3.3)?: [Ja/Nee — if Ja, see §8]

**Recommendation**: [PROCEED / PROCEED WITH CONDITIONS / DO NOT PROCEED —
ESCALATE]

---

## 1. Scope & Applicability

**Applies to**: all Rijksoverheid organisations except de Hoge Colleges van
Staat. **Defensie is exempt** from the Herziening rijksbreed cloudbeleid 2026.

**This organisation**: [ORGANISATION_NAME] — [In scope / Hoge College van Staat,
out of scope / Defensie, exempt]

**Transition arrangements**:

- Existing materieel cloudgebruik: **4-year transition period** from the
  policy's effective date to come into compliance.
- Exit plans for existing use: due within **12 months** of the policy's
  effective date (see `nl-exit-plan-template.md`).

**This assessment covers**: [New procurement, assessed before commitment /
Existing use, being brought into the transition programme — state which and the
relevant date]

---

## 2. Materieel Cloudgebruik Determination (§4.1)

Per §4.1, **materieel publiek cloudgebruik** means: (a) use for the
organisation's primary/core task, **or** (b) large-scale processing of personal
data. Defer to the OBDO Cloud definities en begrippenlijst (16 april 2026) for
the authoritative definition.

| Test                                                               | Answer   | Evidence                                            |
| ------------------------------------------------------------------ | -------- | --------------------------------------------------- |
| (a) Is this service used for the organisation's primary/core task? | [Ja/Nee] | [Evidence]                                          |
| (b) Does this service process personal data at large scale?        | [Ja/Nee] | [Evidence, cross-reference the data-model artifact] |

**Determination**: [MATERIEEL cloudgebruik — full policy applies / NIET
materieel — lighter-touch handling; still record in the gekend-gebruik register
if applicable per §3.4]

---

## 3. Integral Risk Assessment (§3.1)

§3.1 requires an integral risk assessment for materieel cloudgebruik, based on
the BIV/TBB classification, plus:

- A **pre-scan DPIA**, and a full **DPIA** if personal data is processed.
- A **DTIA** (Data Transfer Impact Assessment) if there is a third-country
  transfer without an adequacy decision.

| Input                                         | Status                                                  | Reference                                |
| --------------------------------------------- | ------------------------------------------------------- | ---------------------------------------- |
| BIV/TBB classification (`nl-tbb`)             | [Complete / In progress / Not started]                  | `ARC-{ID}-NLTBB-v*.md`                   |
| Pre-scan DPIA                                 | [Complete — outcome: DPIA required/not required]        | `ARC-{ID}-DPIA-v*.md` (pre-scan section) |
| Full DPIA (if personal data processed)        | [Complete / Not applicable — no personal data]          | `ARC-{ID}-DPIA-v*.md`                    |
| DTIA (if third-country transfer, no adequacy) | [Complete / Not applicable — no third-country transfer] | `ARC-{ID}-NLDTIA-v*.md`                  |

**Integral risk assessment conclusion**: [Summary — cite the BIV/TBB
determination and any DPIA/DTIA findings that bear on the cloud eligibility
verdict in §5]

---

## 4. C2000, ABRO and AIVD/MIVD Advice (§4.2)

§4.2 applies additional criteria for services touching C2000 (the emergency
services communication network), ABRO (Algemene Beveiligingseisen voor
Rijksoverheidsopdrachten), or where AIVD/MIVD advice is relevant.

| Criterion                                        | Applicable? | Evidence / Advice Reference |
| ------------------------------------------------ | ----------- | --------------------------- |
| Service touches or depends on C2000              | [Ja/Nee]    | [Reference]                 |
| ABRO criteria apply (Algemene Beveiligingseisen) | [Ja/Nee]    | [Reference]                 |
| AIVD/MIVD advice sought                          | [Ja/Nee]    | [Advice reference, date]    |

---

## 5. Cloud Eligibility Determination

This section records the governance facts supplied to the `nlCloudEligibility`
model method and its resulting verdict. The method is **fail-closed** — every
fact below is a required argument; omitting one is rejected rather than
defaulted to the permissive value.

| Governance fact                                     | Value                                                                                           | Source                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `rubricering` and/or `tbbCategory`                  | [From `nl-tbb`]                                                                                 | `ARC-{ID}-NLTBB-v*.md`                               |
| `processingRegion`                                  | [EEA / Switzerland / other — name the region]                                                   | [Evidence]                                           |
| `supplierJurisdiction`                              | [Jurisdiction(s) the supplier and sub-processors fall under — distinct from `processingRegion`] | [Contract / vendor disclosure]                       |
| `isPrimaryProcess`                                  | [true/false]                                                                                    | [Evidence]                                           |
| `isBasisregistratie`                                | [true/false]                                                                                    | [Evidence]                                           |
| `isEmailOrWorkplace`                                | [true/false]                                                                                    | [Evidence]                                           |
| `continuityEstablishedIndependently` (§4.5 cond. 1) | [true/false]                                                                                    | [Evidence — only meaningful if `isEmailOrWorkplace`] |
| `riskAnalysisAndExitPlanTested` (§4.5 cond. 2)      | [true/false]                                                                                    | [Evidence — cross-reference `nl-exit`]               |
| `ministerialApprovalObtained` (§4.5 cond. 3)        | [true/false]                                                                                    | [Evidence]                                           |
| `isVitaleAanbieder`                                 | [true/false]                                                                                    | [Evidence]                                           |
| `isWwkeEntity`                                      | [true/false]                                                                                    | [Evidence]                                           |
| `isCbwEssentialEntity`                              | [true/false]                                                                                    | [Evidence]                                           |

```bash
swamp model method run governance nlCloudEligibility \
  --input subject="[SYSTEM/SERVICE NAME]" --input project="[PROJECT_DIR]" \
  --input rubricering="[...]" --input tbbCategory="[...]" \
  --input processingRegion="[...]" --input supplierJurisdiction="[...]" \
  --input isPrimaryProcess=[true/false] --input isBasisregistratie=[true/false] \
  --input isEmailOrWorkplace=[true/false] \
  --input continuityEstablishedIndependently=[true/false] \
  --input riskAnalysisAndExitPlanTested=[true/false] \
  --input ministerialApprovalObtained=[true/false] \
  --input isVitaleAanbieder=[true/false] --input isWwkeEntity=[true/false] \
  --input isCbwEssentialEntity=[true/false]
```

**Resulting verdict**: **[ALLOWED / CONDITIONAL / DISCOURAGED / PROHIBITED]**

**Verdict rank note**: the four verdicts are a strict total order — prohibited

> conditional > discouraged > allowed — resolved as the maximum over every fired
> clause, never first-match. If more than one clause fires, all of them are
> listed below, not just the one that determined the verdict.

**Clauses cited**:

| Clause      | Text (from the method's `reason`/`clauses` output) |
| ----------- | -------------------------------------------------- |
| [e.g. §5.2] | [Reason text]                                      |

**§4.5 condition detail** (only populated when `isEmailOrWorkplace=true`):
public cloud email/workplace storage requires **all three** conditions —
continuity established independently of the supplier, a tested risk analysis +
exit plan, and ministerial approval agreed with the bewindspersoon voor
digitalisering. Any one missing keeps the verdict at **conditional**, not
allowed.

| Condition                            | Met?     |
| ------------------------------------ | -------- |
| Continuity established independently | [Ja/Nee] |
| Risk analysis + exit plan tested     | [Ja/Nee] |
| Ministerial approval obtained        | [Ja/Nee] |

**Hard exclusions** (§5.2, §5.4 — always PROHIBITED, no conditional path):

- Public cloud is **prohibited** for staatsgeheim gerubriceerde informatie and
  for TBB niveau 1, 2 and 3 (§5.2).
- **Basisregistraties** may not be hosted on public cloud; their source data is
  not managed there (§5.4).

**Residency, encryption and key management (§4.6)**: storage and processing must
stay within the **EEA + Switzerland** — **Caribisch Nederland is explicitly NOT
covered** by this residency allowance. Encryption is required at rest, in
transit, and possibly in processing; key management should preferably **not**
sit with the provider. Bijzondere persoonsgegevens (special category personal
data) should preferably not be placed on public cloud, and privacy-enhancing
technologies (PETs) should be considered where they are.

| §4.6 control                                                         | Status                             |
| -------------------------------------------------------------------- | ---------------------------------- |
| Processing region within EEA + Switzerland (not Caribisch Nederland) | [Confirmed/Not confirmed]          |
| Encryption at rest                                                   | [Confirmed/Not confirmed]          |
| Encryption in transit                                                | [Confirmed/Not confirmed]          |
| Encryption in processing (where feasible)                            | [Confirmed/Not applicable]         |
| Key management NOT held by the provider                              | [Confirmed/Provider-held — flag]   |
| Bijzondere persoonsgegevens present?                                 | [Ja/Nee — if Ja, PETs considered?] |

---

## 6. Gekend Gebruik Register (§3.4)

§3.4 requires organisations to register and report **gekend gebruik**
(known/acknowledged cloud use, including non-materieel use) annually to CIO
Rijk.

| Field                                  | Value           |
| -------------------------------------- | --------------- |
| Registered in gekend-gebruik register? | [Ja/Nee — date] |
| Next annual report to CIO Rijk         | [DATE]          |

---

## 7. Melding to CISO Rijk (§3.3)

§3.3 requires prior melding (notification) to CISO Rijk (cisorijk@minbzk.nl) for
materieel cloudgebruik, who may issue an aanwijzing.

| Field                           | Value                  |
| ------------------------------- | ---------------------- |
| Melding required?               | [Ja/Nee]               |
| Melding submitted (date)        | [DATE / PENDING]       |
| Aanwijzing received?            | [Nee / Ja — summarize] |
| Response to aanwijzing (if any) | [Summary]              |

---

## 8. Exit Plan Linkage (§3.2)

If this assessment's verdict is anything other than **prohibited**, §3.2
requires a mandatory, self-tested exit plan covering two scenarios (planned
exit; disruptive interruption) with data destruction after migration, reviewed
**annually**. See `nl-exit-plan-template.md` (`ARC-{ID}-NLEXIT-v*.md`), whose
mandatory input is this document.

**Exit plan status**: [Not started / In progress / Complete — reference]

---

## 9. Woo Publication & Rubricering of This Assessment (§4.4)

§4.4 notes that this risk analysis and exit plan may themselves carry a
rubricering, and are subject to Woo (Wet open overheid) publication obligations
subject to that rubricering.

| Field                        | Value                                                |
| ---------------------------- | ---------------------------------------------------- |
| Rubricering of THIS document | [See Document Control block above]                   |
| Woo publication status       | [Published / Exempted — rubricering basis / Pending] |

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

**Generated by**: ArcKit `/arckit:nl-cloud` command **Generated on**: [DATE]
**ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**: [AI_MODEL]
