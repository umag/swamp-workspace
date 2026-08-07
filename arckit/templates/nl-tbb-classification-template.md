# NL TBB / Rubricering Classification Assessment

> **Template Origin**: Community Overlay (nl-gov) | **ArcKit Version**:
> [VERSION] | **Command**: `/arckit:nl-tbb`

> ⚠️ **NOT OFFICIALLY VALIDATED.** This is a community jurisdiction overlay
> template for the ArcKit swamp port, grounding NL sovereign-cloud governance in
> the cited instruments below. It is not reviewed or endorsed by
> tractorjuice/arc-kit upstream, EZK, BZK, the OBDO, or any Dutch government
> body. **Verify every citation against the primary source (wetten.overheid.nl /
> officiëlebekendmakingen.nl / the issuing department) before relying on this
> document for a real classification or governance decision.** A classification
> determination under VIRBI 2025 must ultimately be made or confirmed by someone
> holding NL security-classification authority — this template produces a
> working draft, not an authoritative determination.

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time to _partials/document-control-nl.md (default for the nl-gov profile), or _partials/document-control-uk.md / _partials/document-control-uae.md based on plugin userConfig classification_scheme + governance_framework. See _partials/RENDERING.md (when present). -->

## Revision History

| Version   | Date   | Author    | Changes                                        | Approved By | Approval Date |
| --------- | ------ | --------- | ---------------------------------------------- | ----------- | ------------- |
| [VERSION] | [DATE] | ArcKit AI | Initial creation from `/arckit:nl-tbb` command | [PENDING]   | [PENDING]     |

## Legal & Policy Grounding

> Cite instrument + date on every determination in this document. Do not rely on
> this list alone — follow the links/references to the primary source.

| Instrument                                                                                        | Date / Reference                                  | Relevance                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VIRBI 2025** — Besluit voorschrift informatiebeveiliging rijksdienst bijzondere informatie 2025 | BWBR0051482, in force **9 September 2025**        | Defines the rubricering scale (Stg. ZEER GEHEIM / Stg. GEHEIM / Stg. CONFIDENTIEEL / Dep. VERTROUWELIJK) used in this document. **Replaces and repeals VIRBI 2013 on the same date** — any artifact still citing VIRBI 2013 is stale. |
| **TBB systematiek** — Gereedschap: Te Beschermen Belangen                                         | v1.0, 2026-06-06 (part of the Toolkit VIRBI 2025) | The BIV-scoring method that determines a TBB 1–4 category, used in this document.                                                                                                                                                     |
| **Besluit BVA-stelsel Rijksdienst 2021**                                                          | BWBR0044617                                       | Legal basis for the TBB systematiek / BVA (beveiliging van vitale aanbieders) stelsel.                                                                                                                                                |
| **Herziening rijksbreed cloudbeleid 2026**                                                        | Ministerie van EZK, 3 juli 2026, definitief       | §5.2 (Gerubriceerde data) uses this document's rubricering/TBB output to determine public-cloud eligibility — public cloud is prohibited for staatsgeheim and for TBB 1/2/3. See `nl-cloud-assessment-template.md`.                   |

## Document Purpose

[Brief description: this document establishes the Te Beschermen Belangen (TBB)
category and/or VIRBI 2025 rubricering level for the system/service in scope, as
the mandatory upstream input to the nl-cloud eligibility assessment and to any
use of the `nlCloudEligibility` model method.]

---

## Executive Summary

**Subject assessed**: [SYSTEM/SERVICE NAME]

**Highest BIV impact found**: [Zeer Hoog / Hoog / Midden / Laag]

**TBB category (this document's determination)**: [TBB 1 / TBB 2 / TBB 3 / TBB 4
/ N.v.t.]

**VIRBI 2025 rubricering (this document's determination)**: [Stg. ZEER GEHEIM /
Stg. GEHEIM / Stg. CONFIDENTIEEL / Dep. VERTROUWELIJK / Ongerubriceerd]

**Basis for the rubricering**: [Direct VIRBI 2025 rubricering decision / TBB
category mapped via the table in §3 / UK-source document migrated via the
crosswalk in §6 — state which]

**Classification authority sign-off**: [PENDING — name/role of the person with
NL security-classification authority who confirmed this determination]

---

## 1. Te Beschermen Belangen (TBB) Identification

The TBB systematiek scores impact against five **kernbelangen** (core
interests). Identify which kernbelangen this system/service could affect if
compromised.

| Kernbelang                  | Applicable? | Why (1–2 sentences) |
| --------------------------- | ----------- | ------------------- |
| Democratische rechtsorde    | [Ja/Nee]    | [Reasoning]         |
| Internationale betrekkingen | [Ja/Nee]    | [Reasoning]         |
| Veiligheid                  | [Ja/Nee]    | [Reasoning]         |
| Gevoelige beleidszaken      | [Ja/Nee]    | [Reasoning]         |
| Betrouwbare dienstverlening | [Ja/Nee]    | [Reasoning]         |

**Scope note**: [Describe the system/service, the data it processes, and which
of the five kernbelangen above drove the inclusion of any BIV score in §2 — do
not score a kernbelang marked "Nee" here.]

---

## 2. BIV Impact Scoring

Score **Vertrouwelijkheid (Confidentiality)**, **Integriteit (Integrity)**, and
**Beschikbaarheid (Availability)** independently, each on the TBB systematiek's
four-point scale: **Zeer Hoog / Hoog / Midden / Laag**. Score against every
kernbelang marked "Ja" above and record the reasoning — a bare level with no
justification is not defensible at review.

| Aspect (BIV)          | Kernbelang(en) scored against | Impact if compromised                                | Score (Zeer Hoog/Hoog/Midden/Laag) | Justification   |
| --------------------- | ----------------------------- | ---------------------------------------------------- | ---------------------------------- | --------------- |
| **V**ertrouwelijkheid | [Kernbelang]                  | [What happens on unauthorized disclosure]            | [Score]                            | [Justification] |
| **I**ntegriteit       | [Kernbelang]                  | [What happens on unauthorized/undetected alteration] | [Score]                            | [Justification] |
| **B**eschikbaarheid   | [Kernbelang]                  | [What happens on loss of availability]               | [Score]                            | [Justification] |

**Highest score across all three (V/I/B)**: [Zeer Hoog / Hoog / Midden / Laag] —
this single highest score sets the TBB category in §3. A high Beschikbaarheid
score with low Vertrouwelijkheid/Integriteit still yields the
Beschikbaarheid-driven TBB category; do not average the three scores.

---

## 3. TBB Category Determination

The **highest** of the three BIV scores in §2 sets the TBB category, per the TBB
systematiek (Gereedschap v1.0, 2026-06-06):

| Highest BIV impact | TBB category | VIRBI 2025 rubricering equivalent                 |
| ------------------ | ------------ | ------------------------------------------------- |
| Zeer Hoog          | **TBB 1**    | Stg. ZEER GEHEIM                                  |
| Hoog               | **TBB 2**    | Stg. GEHEIM                                       |
| Midden             | **TBB 3**    | Stg. CONFIDENTIEEL                                |
| Laag               | **TBB 4**    | Dep. VERTROUWELIJK, or ongerubriceerd met merking |

**Determined TBB category**: [TBB 1 / TBB 2 / TBB 3 / TBB 4]

**Basis**: highest BIV score from §2 was **[score]** on **[V/I/B]**, scored
against kernbelang **[name]**.

---

## 4. VIRBI 2025 Rubricering

VIRBI 2025 (BWBR0051482, in force 9 September 2025) defines four rubricering
levels. This section records the direct rubricering decision, where one is made
independently of (or in addition to) the TBB mapping above.

| Rubricering level      | Meaning                                         | Applies here? |
| ---------------------- | ----------------------------------------------- | ------------- |
| **Stg. ZEER GEHEIM**   | Staatsgeheim — impact zeer hoog                 | [Ja/Nee]      |
| **Stg. GEHEIM**        | Staatsgeheim — impact hoog                      | [Ja/Nee]      |
| **Stg. CONFIDENTIEEL** | Staatsgeheim — impact midden                    | [Ja/Nee]      |
| **Dep. VERTROUWELIJK** | Departementaal vertrouwelijk (non-staatsgeheim) | [Ja/Nee]      |

**Determined rubricering**: [Stg. ZEER GEHEIM / Stg. GEHEIM / Stg. CONFIDENTIEEL
/ Dep. VERTROUWELIJK / Ongerubriceerd]

**VIRBI 2013 check**: confirm no source document consulted for this
determination still cites VIRBI 2013 (BWBR — repealed 9 September 2025,
superseded in full by VIRBI 2025). [Confirmed / Stale reference found — escalate
before proceeding]

---

## 5. One-Way Inference Rule (TBB ↔ Rubricering)

**The inference between rubricering and TBB category runs in one direction
only**:

- Stg. GEHEIM **implies** TBB 2 (a staatsgeheim rubricering is evidence of at
  least that TBB impact level).
- TBB 2 **does NOT imply** Stg. GEHEIM (a TBB 2 impact score does not by itself
  establish a staatsgeheim rubricering — a separate rubricering decision under
  VIRBI 2025 is required for that).

Do not apply this inference in the disallowed direction anywhere downstream of
this document, including when calling the `nlCloudEligibility` model method (§7)
— if a caller supplies a lenient `tbbCategory` alongside a strict `rubricering`,
the model resolves to the **more restrictive** of the two; it does not let a
lenient TBB water down an established staatsgeheim rubricering.

---

## 6. UK → NL Classification Crosswalk (`migrateClassification --ladder nl`)

The `@magistr/arckit/workspace` model's `migrateClassification` method supports
a `ladder` argument. `ladder: "nl"` rewrites a UK-labelled Document Control
`Classification` line to its NL rubricering target using this table:

| UK source level    | NL rubricering target | Basis                                                  |
| ------------------ | --------------------- | ------------------------------------------------------ |
| SECRET             | Stg. GEHEIM           | Sourced — BMI equivalence table, via NATO SECRET       |
| TOP SECRET         | Stg. ZEER GEHEIM      | Sourced — BMI equivalence table, via COSMIC TOP SECRET |
| PUBLIC             | Ongerubriceerd        | Reasoned, not cited — floor to floor                   |
| OFFICIAL           | _(refused)_           | No published equivalence — decide by hand              |
| OFFICIAL-SENSITIVE | _(refused)_           | No published equivalence — decide by hand              |

**Sourced rows.** The German Federal Ministry of the Interior publishes an
official cross-national equivalence table (`BMI-IS-20060329-KF01-A004.1`,
verwaltungsvorschriften-im-internet.de) aligning NATO markings with both NL and
UK national markings. Routing UK → NATO → NL through it gives
`SECRET ≡ NATO SECRET ≡ GEHEIM STG` and
`TOP SECRET ≡ COSMIC TOP SECRET ≡ ZEER GEHEIM STG`.

**`PUBLIC → Ongerubriceerd` is reasoned, not cited.** Both denote the absence of
a classification, and `Ongerubriceerd` is the lowest NL level, so the mapping
cannot under-protect.

**`OFFICIAL` and `OFFICIAL-SENSITIVE` are refused, not guessed.** The BMI
table's UK row is the pre-2014 scheme (RESTRICTED / CONFIDENTIAL / SECRET / TOP
SECRET); the UK replaced its lower tiers with OFFICIAL and the `-SENSITIVE`
handling caveat in April 2014, and no published UK → NL equivalence covers them.
The migration therefore leaves such lines **byte-unchanged** and reports them in
the run's `skipped` list for an explicit decision. Record those decisions here:

| Artifact  | UK source value | Rubricering assigned | Decided by | Role / classification authority | Date      |
| --------- | --------------- | -------------------- | ---------- | ------------------------------- | --------- |
| [PENDING] | [PENDING]       | [PENDING]            | [PENDING]  | [PENDING]                       | [PENDING] |

**`Stg. CONFIDENTIEEL` is unreachable by migration** — by the BMI table it
corresponds to UK CONFIDENTIAL, a level the UK abolished in April 2014. Nothing
in the current UK ladder maps onto it. Assign it directly where the damage
criteria warrant, rather than expecting a migration to produce it.

> ⚠️ **This ladder rewrites governance-document markings only.** UK Cabinet
> Office guidance (_International Classified Exchanges_ v1.5, March 2020, Annex
> B) is that international classified information is **not** re-marked with
> another nation's classification; the norm is to protect it at the equivalent
> level. Do not point this migration at genuine foreign classified material.

---

## 7. Downstream Use

This document is the mandatory input for:

- **`nl-cloud-assessment-template.md`** (`/arckit:nl-cloud`) — §5.2 of the
  Rijksbreed cloudbeleid 2026 (Gerubriceerde data) keys off the TBB/rubricering
  determination made here: public cloud is prohibited for staatsgeheim
  gerubriceerde informatie and for TBB niveau 1, 2 and 3.
- The **`nlCloudEligibility`** model method — pass this document's
  determinations as its `rubricering` and/or `tbbCategory` arguments (at least
  one required; both accepted — the model resolves the more restrictive when
  they disagree, per §5 above):

  ```bash
  swamp model method run governance nlCloudEligibility \
    --input subject="[SYSTEM/SERVICE NAME]" \
    --input rubricering="[Stg. GEHEIM | Stg. CONFIDENTIEEL | Dep. VERTROUWELIJK | Ongerubriceerd | Stg. ZEER GEHEIM]" \
    --input tbbCategory="[TBB 1 | TBB 2 | TBB 3 | TBB 4]" \
    --input processingRegion=... --input supplierJurisdiction=... \
    # ... remaining governance-fact arguments (fail-closed — all required)
  ```

  `rubricering` and `tbbCategory` are validated at the argument schema (zod
  enum) — an unrecognized value is rejected before the method body runs, listing
  the valid set.

---

## 8. Review & Sign-Off

| Role                                          | Name   | Determination Confirmed | Date | Signature |
| --------------------------------------------- | ------ | ----------------------- | ---- | --------- |
| Author                                        | [Name] |                         |      |           |
| Departementaal Security Officer / equivalent  | [Name] |                         |      |           |
| NL security-classification authority (§6, §4) | [Name] |                         |      |           |

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

**Generated by**: ArcKit `/arckit:nl-tbb` command **Generated on**: [DATE]
**ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**: [AI_MODEL]
