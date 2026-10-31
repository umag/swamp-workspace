<!-- arckit-overlay-template: au-aescsf-template.md -->

# AU AESCSF Maturity Assessment

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:au-aescsf`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->
<!-- Document Type: AUAESCSF -->

## Revision History

| Version   | Date         | Author    | Changes                                           | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:au-aescsf` command | PENDING     | PENDING       |

---

## Executive Summary

[Summarise AESCSF scope, target maturity, current posture, highest-risk gaps,
architecture evidence gaps, and top uplift priorities.]

---

## Energy Context and AESCSF Scope

[Describe the energy sub-sector, entity role, asset or platform, market
participation, operational context, and AESCSF applicability assumptions.]

---

## Criticality and Target Maturity Profile

| Dimension                   | Current Position | Target / Rationale | Evidence           |
| --------------------------- | ---------------- | ------------------ | ------------------ |
| Service criticality         | [Position]       | [Target]           | [Evidence]         |
| Safety / reliability impact | [Position]       | [Target]           | [Evidence]         |
| Market impact               | [Position]       | [Target]           | [Evidence]         |
| SOCI relevance              | [Position]       | [Target]           | [AUSOCI reference] |
| Target AESCSF maturity      | [Position]       | [Target]           | [Rationale]        |

---

## Domain Maturity Assessment

| AESCSF Domain / Capability Area | Current Maturity | Target Maturity | Evidence   | Gap   | Owner   |
| ------------------------------- | ---------------- | --------------- | ---------- | ----- | ------- |
| [Domain]                        | [Current]        | [Target]        | [Evidence] | [Gap] | [Owner] |

---

## OT/IT and Grid-Edge Findings

[Summarise OT/IT boundary findings, grid-edge dependencies, DERMS / DOE /
CSIP-AUS flows, telemetry, metering, vendor access, and operational
constraints.]

---

## Architecture Evidence

| Evidence Required               | Status                              | Artefact / Link       | Owner   | Gap   |
| ------------------------------- | ----------------------------------- | --------------------- | ------- | ----- |
| OT/IT zone and conduit diagrams | [Current / Partial / Missing]       | [Diagram]             | [Owner] | [Gap] |
| IT/OT data flows                | [Current / Partial / Missing]       | [DFD]                 | [Owner] | [Gap] |
| DERMS / DOE / CSIP-AUS flows    | [Current / Partial / Missing / N/A] | [DFD / diagram]       | [Owner] | [Gap] |
| Vendor remote-access paths      | [Current / Partial / Missing]       | [Register / diagram]  | [Owner] | [Gap] |
| Energy data-model dependencies  | [Current / Partial / Missing]       | [Data model]          | [Owner] | [Gap] |
| Traceability and risk links     | [Current / Partial / Missing]       | [Traceability / risk] | [Owner] | [Gap] |

---

## IT/OT and Market Data Flows

| Flow   | Source   | Destination   | Protocol / Interface | Data   | Control   | Evidence   |
| ------ | -------- | ------------- | -------------------- | ------ | --------- | ---------- |
| [Flow] | [Source] | [Destination] | [Interface]          | [Data] | [Control] | [Evidence] |

---

## Energy Data Model Dependencies

| Data Domain            | Dependency   | Owner   | Classification / Sensitivity | Control / Evidence |
| ---------------------- | ------------ | ------- | ---------------------------- | ------------------ |
| Asset / network model  | [Dependency] | [Owner] | [Classification]             | [Evidence]         |
| DER / grid-edge        | [Dependency] | [Owner] | [Classification]             | [Evidence]         |
| Metering / NMI         | [Dependency] | [Owner] | [Classification]             | [Evidence]         |
| Settlement / market    | [Dependency] | [Owner] | [Classification]             | [Evidence]         |
| Customer / billing     | [Dependency] | [Owner] | [Classification]             | [Evidence]         |
| Telemetry / operations | [Dependency] | [Owner] | [Classification]             | [Evidence]         |

---

## Asset, Interface, and Evidence Inventory

| Register / Inventory                 | Source of Truth                      | Items in Scope                                  | Owner   | Visualisation / Scoring            | Gap   |
| ------------------------------------ | ------------------------------------ | ----------------------------------------------- | ------- | ---------------------------------- | ----- |
| OT asset inventory                   | [CMDB / asset register / AUOT]       | [Zones, conduits, devices, control systems]     | [Owner] | [Criticality / risk colour coding] | [Gap] |
| IT / service inventory               | [ServiceNow / CMDB / diagram]        | [Applications, services, infrastructure CIs]    | [Owner] | [Support tier / dependency score]  | [Gap] |
| Market and AEMO interface register   | [Interface register / DFD]           | [APIs, portals, B2B/B2M, files, telemetry]      | [Owner] | [Availability / compliance status] | [Gap] |
| DER / metering / telemetry inventory | [Data model / asset register]        | [DERMS, DOE, CSIP-AUS, meters, telemetry paths] | [Owner] | [Maturity / risk heat]             | [Gap] |
| Vendor remote-access register        | [Access register / AUOT / risk]      | [Vendors, jump hosts, privileged sessions]      | [Owner] | [Residual risk / control status]   | [Gap] |
| Evidence and control register        | [Traceability / graph-report / risk] | [Controls, obligations, evidence, tests]        | [Owner] | [Coverage / readiness score]       | [Gap] |

---

## Diagram and Traceability Handoffs

| Handoff           | Required Update                                             | Owner   | Status   |
| ----------------- | ----------------------------------------------------------- | ------- | -------- |
| DFD               | [IT/OT, market, DER, vendor access flows]                   | [Owner] | [Status] |
| Diagram           | [Zones, conduits, market interfaces, grid-edge context]     | [Owner] | [Status] |
| Data Model        | [Energy data dependencies and ownership]                    | [Owner] | [Status] |
| ServiceNow / CMDB | [CIs, service dependencies, owners, support criticality]    | [Owner] | [Status] |
| Traceability      | [Requirements, controls, evidence, obligations]             | [Owner] | [Status] |
| Risk              | [Maturity gaps and treatment actions]                       | [Owner] | [Status] |
| Graph Report      | [Coverage, cross-reference density, missing evidence links] | [Owner] | [Status] |

---

## AESCSF Anti-Pattern Register

| Anti-Pattern   | Evidence   | Impact   | Treatment   |
| -------------- | ---------- | -------- | ----------- |
| [Anti-pattern] | [Evidence] | [Impact] | [Treatment] |

---

## Federal Baseline Cross-Reference

| Artefact | Reference           | How Used                           | Gap / Follow-up |
| -------- | ------------------- | ---------------------------------- | --------------- |
| AUE8     | [ARC-{P}-AUE8-v*]   | [Enterprise cyber baseline]        | [Gap]           |
| AUISM    | [ARC-{P}-AUISM-v*]  | [Control evidence]                 | [Gap]           |
| AUOT     | [ARC-{P}-AUOT-v*]   | [OT evidence]                      | [Gap]           |
| AUSOCI   | [ARC-{P}-AUSOCI-v*] | [Critical-infrastructure evidence] | [Gap]           |

---

## Maturity Gaps and Risk Treatment

| Gap   | Risk   | Treatment   | Owner   | Due Date | Residual Risk   |
| ----- | ------ | ----------- | ------- | -------- | --------------- |
| [Gap] | [Risk] | [Treatment] | [Owner] | [Date]   | [Residual risk] |

---

## Uplift Roadmap

| Horizon     | Action   | Owner   | Evidence Update | Success Measure |
| ----------- | -------- | ------- | --------------- | --------------- |
| Immediate   | [Action] | [Owner] | [Artefact]      | [Measure]       |
| 30-90 days  | [Action] | [Owner] | [Artefact]      | [Measure]       |
| 90-180 days | [Action] | [Owner] | [Artefact]      | [Measure]       |
| Strategic   | [Action] | [Owner] | [Artefact]      | [Measure]       |

---

## External References

### Authoritative Sources

| Ref          | Source                                                 | Version / Publication Date | Access Date  | Relevance                               |
| ------------ | ------------------------------------------------------ | -------------------------- | ------------ | --------------------------------------- |
| AESCSF       | AEMO Australian Energy Sector Cyber Security Framework | [Version / date verified]  | [YYYY-MM-DD] | Authoritative AESCSF anchor             |
| AEMO-CYBER   | AEMO cyber security resources                          | [Date verified]            | [YYYY-MM-DD] | Energy-sector cyber context             |
| AEMO-SYSTEMS | AEMO energy systems and interfaces                     | [Date verified]            | [YYYY-MM-DD] | Market and operator interface context   |
| CISC-SOCI    | CISC SOCI Act 2018 guidance                            | [Date verified]            | [YYYY-MM-DD] | Critical-infrastructure cross-reference |
| ASD-E8       | ASD Essential Eight                                    | [Version / date verified]  | [YYYY-MM-DD] | Enterprise cyber baseline               |
| ASD-ISM      | ASD Information Security Manual                        | [Edition / date verified]  | [YYYY-MM-DD] | Control evidence baseline               |

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

## Document Metadata

| Item                                       | Value                                                                |
| ------------------------------------------ | -------------------------------------------------------------------- |
| Document Type                              | AUAESCSF                                                             |
| Template Origin                            | Community                                                            |
| Command                                    | `/arckit:au-aescsf`                                                  |
| AESCSF Version / Publication Date Verified | [Version / date]                                                     |
| AEMO Access Date                           | [YYYY-MM-DD]                                                         |
| AEMO Availability Notes                    | [Available / unavailable / partial; record attempts]                 |
| Qualified Review Required                  | [Energy cyber / OT / legal / regulatory / operational risk reviewer] |

---

**Generated by**: ArcKit `/arckit:au-aescsf` command **Generated on**: [DATE]
**ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**: [AI_MODEL]

<!-- arckit-overlay-template: au-energy-compliance-template.md -->

# AU Energy Compliance Pack

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:au-energy-compliance`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->
<!-- Document Type: AUENERGY -->

## Revision History

| Version   | Date         | Author    | Changes                                                      | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------------------------ | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:au-energy-compliance` command | PENDING     | PENDING       |

---

## Executive Summary

[Summarise energy-sector applicability, ring-fencing posture, NER / NGR and AEMO
interface implications, SOCI escalation gaps, architecture evidence status, and
recommendations.]

---

## Energy-Sector Applicability

[Identify energy sub-sector, entity role, regulated services, affiliates, market
participant status, system-operator interactions, gas or electricity context,
DER, metering, settlement, and customer data scope.]

---

## AER Ring-Fencing Assessment

| Boundary / Obligation Area                | Current Position | Evidence   | Gap   | Qualified Review Needed |
| ----------------------------------------- | ---------------- | ---------- | ----- | ----------------------- |
| Regulated / unregulated business boundary | [Position]       | [Evidence] | [Gap] | [Yes / No]              |
| Shared services                           | [Position]       | [Evidence] | [Gap] | [Yes / No]              |
| Staff and system access                   | [Position]       | [Evidence] | [Gap] | [Yes / No]              |
| Affiliate data sharing                    | [Position]       | [Evidence] | [Gap] | [Yes / No]              |
| Branding and cross-promotion              | [Position]       | [Evidence] | [Gap] | [Yes / No]              |
| Waivers / exemptions                      | [Position]       | [Evidence] | [Gap] | [Yes / No / N/A]        |

---

## NER / NGR and AEMO Obligation Mapping

| Obligation Area         | Source   | Architecture Impact | Evidence   | Owner   |
| ----------------------- | -------- | ------------------- | ---------- | ------- |
| [NER / NGR / AEMO area] | [Source] | [Impact]            | [Evidence] | [Owner] |

---

## Energy-Specific SOCI Interpretation

| SOCI Topic               | Applicability | Evidence                 | Escalation / Follow-up |
| ------------------------ | ------------- | ------------------------ | ---------------------- |
| Critical asset class     | [Position]    | [AUSOCI reference]       | [Follow-up]            |
| CIRMP hazard             | [Position]    | [Evidence]               | [Follow-up]            |
| Protected information    | [Position]    | [Evidence]               | [Follow-up]            |
| SOCI incident escalation | [Position]    | [Runbook / contact path] | [Follow-up]            |

---

## Market and System-Operator Interface Register

| Interface                          | Operator / Counterparty | Purpose   | Data   | Control   | Evidence   |
| ---------------------------------- | ----------------------- | --------- | ------ | --------- | ---------- |
| [AEMO / market / system interface] | [Counterparty]          | [Purpose] | [Data] | [Control] | [Evidence] |

---

## DER, Metering, Settlement, and Customer Data Implications

| Domain                       | Data / Process   | Regulated Impact | Privacy / Security Impact | Evidence   |
| ---------------------------- | ---------------- | ---------------- | ------------------------- | ---------- |
| DER / DERMS / DOE / CSIP-AUS | [Data / process] | [Impact]         | [Impact]                  | [Evidence] |
| Metering / NMI               | [Data / process] | [Impact]         | [Impact]                  | [Evidence] |
| Settlement / market          | [Data / process] | [Impact]         | [Impact]                  | [Evidence] |
| Customer / billing           | [Data / process] | [Impact]         | [Impact]                  | [Evidence] |

---

## Regulated Asset, Interface, and Data Inventory

| Register / Inventory                  | Source of Truth                           | Items in Scope                                                  | Owner   | Visualisation / Scoring                    | Gap   |
| ------------------------------------- | ----------------------------------------- | --------------------------------------------------------------- | ------- | ------------------------------------------ | ----- |
| Regulated service inventory           | [Service catalogue / CMDB]                | [Regulated services, shared services, support tiers]            | [Owner] | [Ring-fencing status / criticality colour] | [Gap] |
| Critical asset inventory              | [SOCI register / asset register / AUSOCI] | [Critical electricity, gas, market, or system assets]           | [Owner] | [SOCI applicability / residual risk]       | [Gap] |
| AEMO and market interface register    | [Interface register / DFD]                | [APIs, portals, B2B/B2M, files, telemetry]                      | [Owner] | [Compliance / availability status]         | [Gap] |
| Regulated / unregulated data register | [Data model / data catalogue]             | [Customer, NMI, meter, settlement, affiliate, operational data] | [Owner] | [Permitted use / classification]           | [Gap] |
| Vendor and affiliate access register  | [Access register / contracts / AUOT]      | [Vendor, affiliate, support, privileged paths]                  | [Owner] | [Control status / risk heat]               | [Gap] |
| Obligation and evidence register      | [Traceability / graph-report]             | [NER, NGR, AER, AEMO, SOCI, privacy evidence]                   | [Owner] | [Coverage / readiness score]               | [Gap] |

---

## Architecture Evidence

| Evidence Required                      | Status                              | Artefact / Link                | Owner   | Gap   |
| -------------------------------------- | ----------------------------------- | ------------------------------ | ------- | ----- |
| Ring-fencing boundary diagrams         | [Current / Partial / Missing]       | [Diagram]                      | [Owner] | [Gap] |
| Regulated / unregulated data-flow maps | [Current / Partial / Missing]       | [DFD]                          | [Owner] | [Gap] |
| AEMO interface maps                    | [Current / Partial / Missing / N/A] | [Diagram / interface register] | [Owner] | [Gap] |
| SOCI incident escalation               | [Current / Partial / Missing / N/A] | [AUSOCI / runbook]             | [Owner] | [Gap] |
| Energy data model                      | [Current / Partial / Missing]       | [Data model]                   | [Owner] | [Gap] |

---

## Regulated / Unregulated Data Flows

| Flow   | Source   | Destination   | Data Classification | Ring-Fencing Control | Evidence   |
| ------ | -------- | ------------- | ------------------- | -------------------- | ---------- |
| [Flow] | [Source] | [Destination] | [Classification]    | [Control]            | [Evidence] |

---

## Energy Data Model Dependencies

| Entity / Data Domain            | Regulated Use | Unregulated Use | Owner   | Control / Evidence |
| ------------------------------- | ------------- | --------------- | ------- | ------------------ |
| Network asset                   | [Use]         | [Use]           | [Owner] | [Evidence]         |
| Customer / account              | [Use]         | [Use]           | [Owner] | [Evidence]         |
| NMI / meter                     | [Use]         | [Use]           | [Owner] | [Evidence]         |
| DER / device                    | [Use]         | [Use]           | [Owner] | [Evidence]         |
| Market transaction / settlement | [Use]         | [Use]           | [Owner] | [Evidence]         |
| Telemetry / operational event   | [Use]         | [Use]           | [Owner] | [Evidence]         |

---

## Diagram and Traceability Handoffs

| Handoff           | Required Update                                             | Owner   | Status   |
| ----------------- | ----------------------------------------------------------- | ------- | -------- |
| DFD               | [Regulated/unregulated, market, AEMO, customer, DER flows]  | [Owner] | [Status] |
| Diagram           | [Ring-fencing boundary and AEMO interface maps]             | [Owner] | [Status] |
| Data Model        | [Energy data dependencies and permitted usage]              | [Owner] | [Status] |
| ServiceNow / CMDB | [Service CIs, support tiers, dependencies, owners]          | [Owner] | [Status] |
| Traceability      | [Obligations, requirements, controls, evidence]             | [Owner] | [Status] |
| Graph Report      | [Coverage, cross-reference density, missing evidence links] | [Owner] | [Status] |

---

## Architecture Decision Seeds

| Decision Topic | Why It Matters | Options / Notes | Recommended Owner |
| -------------- | -------------- | --------------- | ----------------- |
| [ADR topic]    | [Reason]       | [Options]       | [Owner]           |

---

## Evidence Gaps and Recommendations

| Priority   | Gap   | Recommendation   | Owner   | Due Date | Qualified Review |
| ---------- | ----- | ---------------- | ------- | -------- | ---------------- |
| [Priority] | [Gap] | [Recommendation] | [Owner] | [Date]   | [Reviewer]       |

---

## External References

### Authoritative Sources

| Ref       | Source                                             | Version / Date Verified   | Access Date  | Relevance                           |
| --------- | -------------------------------------------------- | ------------------------- | ------------ | ----------------------------------- |
| AER-RF    | AER ring-fencing guideline                         | [Version / date verified] | [YYYY-MM-DD] | Ring-fencing obligations            |
| AER       | Australian Energy Regulator                        | [Date verified]           | [YYYY-MM-DD] | Regulatory context                  |
| AEMC-NER  | AEMC National Electricity Rules                    | [Version / date verified] | [YYYY-MM-DD] | Electricity obligations             |
| AEMC-NGR  | AEMC National Gas Rules                            | [Version / date verified] | [YYYY-MM-DD] | Gas obligations                     |
| AEMO      | AEMO energy systems and interfaces                 | [Date verified]           | [YYYY-MM-DD] | Market and operator interfaces      |
| CISC-SOCI | CISC SOCI Act 2018 guidance                        | [Date verified]           | [YYYY-MM-DD] | Critical-infrastructure obligations |
| OAIC      | OAIC Privacy Act and Australian Privacy Principles | [Date verified]           | [YYYY-MM-DD] | Customer and personal information   |

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

## Document Metadata

| Item                                      | Value                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| Document Type                             | AUENERGY                                                                 |
| Template Origin                           | Community                                                                |
| Command                                   | `/arckit:au-energy-compliance`                                           |
| AER / AEMC / AEMO / CISC Versions Checked | [Versions / dates]                                                       |
| Access Date                               | [YYYY-MM-DD]                                                             |
| Qualified Review Required                 | [Legal / regulatory / energy compliance / privacy / cyber / OT reviewer] |

---

**Generated by**: ArcKit `/arckit:au-energy-compliance` command **Generated
on**: [DATE] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL]
