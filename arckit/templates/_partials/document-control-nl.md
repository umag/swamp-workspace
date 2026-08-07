| Field                               | Value                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| **Document ID**                     | ARC-[PROJECT_ID]-[TYPE_CODE]-v[VERSION]                                                     |
| **Document Type**                   | [DOCUMENT_TYPE_NAME]                                                                        |
| **Project**                         | [PROJECT_NAME] (Project [PROJECT_ID])                                                       |
| **Rubricering (VIRBI 2025)**        | [Ongerubriceerd / Dep. VERTROUWELIJK / Stg. CONFIDENTIEEL / Stg. GEHEIM / Stg. ZEER GEHEIM] |
| **TBB Category (Gereedschap v1.0)** | [TBB 4 / TBB 3 / TBB 2 / TBB 1 / N.v.t. — not scored]                                       |
| **Status**                          | DRAFT                                                                                       |
| **Version**                         | [VERSION]                                                                                   |
| **Created Date**                    | [YYYY-MM-DD]                                                                                |
| **Last Modified**                   | [YYYY-MM-DD]                                                                                |
| **Review Cycle**                    | [Monthly / Quarterly / Annual / On-Demand]                                                  |
| **Next Review Date**                | [YYYY-MM-DD]                                                                                |
| **Owner**                           | [OWNER_NAME_AND_ROLE]                                                                       |
| **Reviewed By**                     | [PENDING]                                                                                   |
| **Approved By**                     | [PENDING]                                                                                   |
| **Distribution**                    | [DISTRIBUTION_LIST]                                                                         |
| **Rijksoverheid Organisation**      | [ORGANISATION_NAME — dept./uitvoeringsorganisatie]                                          |
| **Instrument(s) cited**             | [PENDING — e.g. Herziening rijksbreed cloudbeleid 2026, VIRBI 2025, BIO2]                   |
| **CISO Rijk melding (§3.3)**        | [N.v.t. / Voorgenomen / Ingediend — DATE / Aanwijzing ontvangen — DATE]                     |

> **NL rubricering note**: this table's Classification-equivalent row is
> `Rubricering (VIRBI 2025)`, deliberately using the official Dutch scale rather
> than the UK `PUBLIC/OFFICIAL/.../TOP SECRET` ladder or the UAE
> `Open/Shared/.../Top Secret` ladder used by the other two Document Control
> partials. `migrateClassification --ladder nl` maps the UK ladder onto this
> scale as a **pragmatic working equivalence** — see the crosswalk table and
> caveat in `nl-tbb-classification-template.md` before treating a migrated value
> as authoritative.
