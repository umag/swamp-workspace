import { z } from "npm:zod@4";

// =============================================================================
// @magistr/arckit/workspace
// Governance-state model over an ArcKit workspace
// (https://github.com/tractorjuice/arc-kit). ArcKit projects live under
// `projects/NNN-name/` as `ARC-{ID}-{TYPE}-v{VER}.md` artifacts; document
// generation is the job of the ArcKit AI-assistant plugin, while this model
// owns the state: `init` scaffolds a workspace, `scan` inventories every
// project and artifact into queryable data, and `gaps` checks each project
// against ArcKit's mandatory-dependency matrix (docs/DEPENDENCY-MATRIX.md)
// and the standard critical path.
// =============================================================================

/** Default cap (bytes) on any single file read whole into memory. */
const DEFAULT_MAX_FILE_BYTES = 10_485_760; // 10 MiB

const GlobalArgsSchema = z.object({
  path: z.string().describe(
    "Absolute path to the ArcKit workspace root (the directory containing projects/)",
  ),
  maxFileBytes: z.number().int().positive().default(DEFAULT_MAX_FILE_BYTES)
    .describe(
      "Reject/skip any single artifact or bundled template file larger than this many bytes (default 10 MiB)",
    ),
});

// ---------- Reference tables (derived from arc-kit docs/DEPENDENCY-MATRIX.md
// and the plugin command specs, arc-kit v6.2.0) ------------------------------

/** Document type code (as embedded in ARC-{ID}-{CODE}-v{VER}) → command. */
export const DOC_CODES: Record<string, string> = {
  "ADR": "adr",
  "AIPB": "ai-playbook",
  "ANAL": "analyze",
  "ATRS": "atrs",
  "AWRS": "aws-research",
  "AZRS": "azure-research",
  "BKLG": "backlog",
  "CMPT": "competitors",
  "CONF": "conformance",
  "DATA": "data-model",
  "DEVOPS": "devops",
  "DFD": "dfd",
  "DIAG": "diagram",
  "DLDR": "dld-review",
  "DMC": "data-mesh-contract",
  "DOS": "dos",
  "DPIA": "dpia",
  "DSCT": "datascout",
  "EVAL": "evaluate",
  "FBC": "full-business-case",
  "FINOPS": "finops",
  "GCLC": "gcloud-clarify",
  "GCLD": "gcloud-search",
  "GCRS": "gcp-research",
  "GCSR": "gov-code-search",
  "GLND": "gov-landscape",
  "GLOS": "glossary",
  "GOVR": "gov-reuse",
  "GRNT": "grants",
  "HLDR": "hld-review",
  "JSP936": "jsp-936",
  "MLOPS": "mlops",
  "MMOD": "maturity-model",
  "OBC": "outline-business-case",
  "OPS": "operationalize",
  "PLAN": "plan",
  "PLAT": "platform-design",
  "PRES": "presentation",
  "PRIN": "principles",
  "PRIN-COMP": "principles-compliance",
  "REQ": "requirements",
  "RISK": "risk",
  "ROAD": "roadmap",
  "RSCH": "research",
  "SECD": "secure",
  "SECD-MOD": "mod-secure",
  "SNOW": "servicenow",
  "SOBC": "sobc",
  "SOW": "sow",
  "STKE": "stakeholders",
  "STORY": "story",
  "STRAT": "strategy",
  "SVCASS": "service-assessment",
  "TCOP": "tcop",
  "TNDR": "tenders",
  "TRAC": "traceability",
  "VEND": "vendor-profile",
  "WARD": "wardley",
  "WCLM": "wardley.climate",
  "WDOC": "wardley.doctrine",
  "WGAM": "wardley.gameplay",
  "WVCH": "wardley.value-chain",

  // ---- NL/EU sovereign-cloud overlay (arckit-nl-sovereign-cloud) ----------
  "NLTBB": "nl-tbb",
  "NLCLD": "nl-cloud",
  "EUSOV": "eu-sovereignty",
  "NLBIO": "nl-bio",
  "NLEXIT": "nl-exit",
  "NLDTIA": "nl-dtia",
};

const CODES_BY_LENGTH = Object.keys(DOC_CODES).sort(
  (a, b) => b.length - a.length,
);

/**
 * command → commands it MANDATORILY depends on (M-level edges only; external
 * inputs like HLD/DLD documents and MCP servers are not detectable on disk
 * and are excluded).
 */
export const MANDATORY_DEPS: Record<string, string[]> = {
  "risk": ["stakeholders"],
  "sobc": ["stakeholders"],
  "platform-design": ["principles"],
  "roadmap": ["principles"],
  "strategy": ["principles", "stakeholders"],
  "data-model": ["requirements"],
  "dpia": ["data-model", "requirements"],
  "research": ["requirements"],
  "azure-research": ["requirements"],
  "aws-research": ["requirements"],
  "gcp-research": ["requirements"],
  "datascout": ["requirements"],
  "grants": ["requirements"],
  "wardley.value-chain": ["requirements"],
  "wardley.doctrine": ["principles"],
  "wardley.gameplay": ["wardley"],
  "wardley.climate": ["wardley"],
  "data-mesh-contract": ["principles"],
  "sow": ["requirements"],
  "dos": ["requirements", "stakeholders"],
  "gcloud-clarify": ["requirements", "gcloud-search"],
  "evaluate": ["requirements", "sow"],
  "hld-review": ["requirements", "principles"],
  "dld-review": ["requirements", "principles"],
  "backlog": ["requirements"],
  "servicenow": ["requirements", "diagram"],
  "devops": ["requirements", "principles"],
  "mlops": ["requirements"],
  "finops": ["requirements"],
  "operationalize": ["requirements", "diagram"],
  "traceability": ["requirements"],
  "analyze": ["principles"],
  "principles-compliance": ["principles"],
  "conformance": ["principles", "adr"],
  "service-assessment": ["requirements"],
  "tcop": ["requirements"],
  "atrs": ["requirements"],
  "secure": ["requirements", "principles"],
  "mod-secure": ["requirements", "principles"],
  "jsp-936": ["requirements", "principles"],
  "story": ["principles"],

  // ---- NL/EU sovereign-cloud overlay (arckit-nl-sovereign-cloud) ----------
  "nl-tbb": ["stakeholders"],
  "nl-cloud": ["requirements", "nl-tbb"],
  "eu-sovereignty": ["requirements"],
  "nl-bio": ["requirements", "principles"],
  "nl-exit": ["nl-cloud"],
  "nl-dtia": ["data-model", "requirements"],
};

/** Standard (non-AI, non-government) project path from the dependency matrix. */
export const CRITICAL_PATH: string[] = [
  "plan",
  "principles",
  "stakeholders",
  "risk",
  "sobc",
  "requirements",
  "research",
  "wardley",
  "sow",
  "evaluate",
  "hld-review",
  "backlog",
  "servicenow",
  "devops",
  "operationalize",
  "traceability",
  "principles-compliance",
  "conformance",
  "analyze",
  "story",
];

/** command → bundled template file under templates/ (arc-kit v6.2.0). */
export const TEMPLATE_MAP: Record<string, string> = {
  "adr": "adr-template.md",
  "ai-playbook": "uk-gov-ai-playbook-template.md",
  "analyze": "analysis-report-template.md",
  "atrs": "uk-gov-atrs-template.md",
  "aws-research": "aws-research-template.md",
  "azure-research": "azure-research-template.md",
  "backlog": "backlog-template.md",
  "competitors": "competitors-template.md",
  "conformance": "conformance-assessment-template.md",
  "data-mesh-contract": "data-mesh-contract-template.md",
  "data-model": "data-model-template.md",
  "datascout": "datascout-template.md",
  "devops": "devops-template.md",
  "dfd": "dfd-template.md",
  "diagram": "architecture-diagram-template.md",
  "dld-review": "dld-review-template.md",
  "dos": "dos-requirements-template.md",
  "dpia": "dpia-template.md",
  "evaluate": "evaluation-criteria-template.md",
  "finops": "finops-template.md",
  "gcloud-clarify": "gcloud-clarify-template.md",
  "gcloud-search": "gcloud-requirements-template.md",
  "gcp-research": "gcp-research-template.md",
  "glossary": "glossary-template.md",
  "gov-code-search": "gov-code-search-template.md",
  "gov-landscape": "gov-landscape-template.md",
  "gov-reuse": "gov-reuse-template.md",
  "grants": "grants-template.md",
  "hld-review": "hld-review-template.md",
  "jsp-936": "jsp-936-template.md",
  "maturity-model": "maturity-model-template.md",
  "mlops": "mlops-template.md",
  "mod-secure": "mod-secure-by-design-template.md",
  "operationalize": "operationalize-template.md",
  // .html.txt: registry allows only .md/.txt-style additionalFiles; strip
  // the .txt suffix if writing this one to disk as a site scaffold.
  "pages": "pages-template.html.txt",
  "plan": "project-plan-template.md",
  "platform-design": "platform-design-template.md",
  "presentation": "presentation-template.md",
  "principles": "architecture-principles-template.md",
  "principles-compliance": "principles-compliance-assessment-template.md",
  "requirements": "requirements-template.md",
  "research": "research-findings-template.md",
  "risk": "risk-register-template.md",
  "roadmap": "roadmap-template.md",
  "secure": "ukgov-secure-by-design-template.md",
  "service-assessment": "service-assessment-prep-template.md",
  "servicenow": "servicenow-design-template.md",
  "sobc": "sobc-template.md",
  "sow": "sow-template.md",
  "stakeholders": "stakeholder-drivers-template.md",
  "story": "story-template.md",
  "strategy": "architecture-strategy-template.md",
  "tcop": "tcop-review-template.md",
  "tenders": "tenders-template.md",
  "traceability": "traceability-matrix-template.md",
  "vendor-profile": "vendor-profile-template.md",
  "wardley": "wardley-map-template.md",
  "wardley.climate": "wardley-climate-template.md",
  "wardley.doctrine": "wardley-doctrine-template.md",
  "wardley.gameplay": "wardley-gameplay-template.md",
  "wardley.value-chain": "wardley-value-chain-template.md",

  // ---- NL/EU sovereign-cloud overlay (arckit-nl-sovereign-cloud) ----------
  "nl-tbb": "nl-tbb-classification-template.md",
  "nl-cloud": "nl-cloud-assessment-template.md",
  "eu-sovereignty": "eu-sovereignty-assessment-template.md",
  "nl-bio": "nl-bio-conformance-template.md",
  "nl-exit": "nl-exit-plan-template.md",
  "nl-dtia": "nl-dtia-template.md",
};

/** command → ARC document type code (inverse of DOC_CODES). */
export const COMMAND_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(DOC_CODES).map(([code, command]) => [command, code]),
);

// ---------- Governance state machine (phases from the DSM tier structure) ----

export const PROFILES = ["standard", "uk-gov", "mod", "ai", "nl-gov"] as const;

export const PHASES = [
  "foundation",
  "context",
  "risk",
  "business-case",
  "requirements",
  "design",
  "procurement",
  "design-review",
  "delivery",
  "operations",
  "assurance",
  "story",
] as const;

/**
 * Every value `projectState.state` may legitimately hold: the phases plus
 * the two terminal states. Constrains the schema seam (LB4) so a corrupted,
 * hand-edited, or datastore-restored unknown-phase value fails to parse
 * instead of silently vacuously satisfying every gate downstream.
 */
export const PROJECT_STATES = [...PHASES, "complete", "abandoned"] as const;

/**
 * Gate per phase: every group must be satisfied; a group is satisfied when
 * ANY of its commands has an artifact on disk (000-global artifacts count).
 * Skippable phases can be bypassed with an explicit recorded reason.
 */
export const PHASE_GATES: Record<
  string,
  { groups: string[][]; skippable: boolean }
> = {
  "foundation": { groups: [["principles"]], skippable: false },
  "context": { groups: [["stakeholders"]], skippable: false },
  "risk": { groups: [["risk"]], skippable: false },
  "business-case": { groups: [["sobc"]], skippable: true },
  "requirements": { groups: [["requirements"]], skippable: false },
  "design": {
    groups: [[
      "research",
      "aws-research",
      "azure-research",
      "gcp-research",
      "data-model",
      "wardley",
      "adr",
      "diagram",
      "dfd",
      "platform-design",
    ]],
    skippable: false,
  },
  "procurement": {
    groups: [["sow", "dos", "gcloud-search", "tenders"]],
    skippable: true,
  },
  "design-review": { groups: [["hld-review"]], skippable: true },
  "delivery": { groups: [["backlog"]], skippable: true },
  "operations": {
    groups: [["operationalize", "servicenow", "devops", "traceability"]],
    skippable: true,
  },
  "assurance": { groups: [["analyze"]], skippable: false },
  "story": { groups: [["story"]], skippable: true },
};

/** Extra gate groups a profile adds to a phase. */
export const PROFILE_EXTRAS: Record<string, Record<string, string[][]>> = {
  "standard": {},
  "uk-gov": { "assurance": [["tcop"], ["secure"]] },
  "mod": { "assurance": [["mod-secure"]] },
  "ai": {
    "design": [["data-model"]],
    "assurance": [["ai-playbook"], ["atrs"]],
  },
  // NL sovereign-cloud overlay (Herziening rijksbreed cloudbeleid 2026, EU
  // Cloud Sovereignty Framework v1.2.1). nl-dtia is deliberately absent here
  // — it is a mandatory INPUT for other artifacts (see MANDATORY_DEPS) but is
  // never itself gate-required.
  "nl-gov": {
    "risk": [["nl-tbb"]],
    "design": [["nl-cloud"]],
    "assurance": [["nl-bio"], ["nl-exit"], ["eu-sovereignty"]],
  },
};

// ---------- Classification migration (port of arckit migrate-classification) -

/** UK classification ladder → UAE Smart Data ladder (arc-kit v4.10 overlay). */
export const CLASSIFICATION_MAPPING: Record<string, string> = {
  "PUBLIC": "Open",
  "OFFICIAL": "Shared",
  "OFFICIAL-SENSITIVE": "Confidential",
  "SECRET": "Secret",
  "TOP SECRET": "Top Secret",
};

const CLASSIFICATION_LINE =
  /^(\|\s*\*\*Classification\*\*\s*\|\s*)(PUBLIC|OFFICIAL|OFFICIAL-SENSITIVE|SECRET|TOP SECRET)(\s*\|)$/gm;

/**
 * UK classification ladder → NL rubricering ladder (VIRBI 2025,
 * BWBR0051482). "Stg." = staatsgeheim. Deliberately NARROW — only the rows
 * that are actually defensible:
 *
 *  - SECRET -> Stg. GEHEIM and TOP SECRET -> Stg. ZEER GEHEIM are SOURCED:
 *    the German BMI's official NATO-equivalence table
 *    (verwaltungsvorschriften-im-internet.de, BMI-IS-20060329-KF01-A004.1)
 *    aligns NATO SECRET / COSMIC TOP SECRET with both NL GEHEIM STG /
 *    ZEER GEHEIM STG and UK SECRET / TOP SECRET, so the UK and NL columns of
 *    that table transit through the same NATO row for these two levels.
 *  - PUBLIC -> Ongerubriceerd is NOT sourced from that table (or any other
 *    citation) — it is REASONED, floor-to-floor: both terms denote "no
 *    classification", and Ongerubriceerd is the lowest NL level, so mapping
 *    PUBLIC to it can never under-protect a document.
 *  - Stg. CONFIDENTIEEL is unreachable from this ladder: its UK counterpart
 *    was CONFIDENTIAL, which the UK ABOLISHED in April 2014 (Government
 *    Security Classifications Policy) — there is no current UK source level
 *    for it, so no UK document can ever migrate to it.
 *  - OFFICIAL and OFFICIAL-SENSITIVE are DELIBERATELY ABSENT. The BMI
 *    table's UK column is the pre-2014 scheme (RESTRICTED / CONFIDENTIAL /
 *    SECRET / TOP SECRET) and its own footnote 5 warns member-state levels
 *    may have changed since publication — it does not cover the post-2014
 *    OFFICIAL / OFFICIAL-SENSITIVE tier that arc-kit's templates actually
 *    carry. No other published UK->NL equivalence for these two exists.
 *    Guessing one would misstate a classification decision, so
 *    proposeClassification refuses to guess: see NL_REQUIRES_EXPLICIT_DECISION.
 *
 * Separately: UK Cabinet Office guidance (International Classified
 * Exchanges v1.5, Annex B) is that internationally-shared classified
 * information is NOT re-marked with another nation's classification — the
 * norm is protect-at-equivalent-level, not relabelling. This ladder is
 * therefore for ArcKit GOVERNANCE-DOCUMENT markings only (Document Control
 * table rows in artifacts this model manages), never a claim about how
 * classified material itself should be marked or exchanged.
 */
const NL_CLASSIFICATION_MAPPING: Record<string, string> = {
  "PUBLIC": "Ongerubriceerd",
  "SECRET": "Stg. GEHEIM",
  "TOP SECRET": "Stg. ZEER GEHEIM",
};

/**
 * UK classification values with NO published post-2014 UK->NL rubricering
 * equivalence (see NL_CLASSIFICATION_MAPPING's doc comment). proposeClassification
 * refuses to guess a target for these under ladder="nl": it leaves the line
 * byte-unchanged and reports the value via `requiresDecision` instead of
 * silently passing it through or inventing a mapping.
 */
export const NL_REQUIRES_EXPLICIT_DECISION = [
  "OFFICIAL",
  "OFFICIAL-SENSITIVE",
] as const;

/** Registered classification-ladder names (migrateClassification's `ladder` argument). */
export const CLASSIFICATION_LADDER_NAMES = ["uae", "nl"] as const;

/**
 * Registry of classification ladders: ONE shared UK SOURCE vocabulary (the
 * CLASSIFICATION_LINE regex above), varying only the TARGET table per
 * ladder. Both ladders answer the same domain question — "what does a
 * UK-labelled document migrate to". Generalizes (and is structurally
 * identical to, for "uae") the pre-existing CLASSIFICATION_MAPPING.
 */
export const CLASSIFICATION_LADDERS: Record<
  typeof CLASSIFICATION_LADDER_NAMES[number],
  Record<string, string>
> = {
  "uae": CLASSIFICATION_MAPPING,
  "nl": NL_CLASSIFICATION_MAPPING,
};

// ---------- EU Cloud Sovereignty Framework v1.2.1 (Sovereignty Objectives) --

/**
 * SOV-1..SOV-8 weights (EU Cloud Sovereignty Framework v1.2.1 Implementation
 * guidance p.7; calculator cells D4/D45/D76/D102/D133/D169/D195/D231) — sum
 * to 100.
 */
const SOV_WEIGHTS: Record<string, number> = {
  "SOV-1": 20,
  "SOV-2": 10,
  "SOV-3": 10,
  "SOV-4": 15,
  "SOV-5": 10,
  "SOV-6": 15,
  "SOV-7": 15,
  "SOV-8": 5,
};

const SOV_IDS = Object.keys(SOV_WEIGHTS);
const SOV_ID_SET = new Set(SOV_IDS);

/**
 * Per-objective ACTUAL achievable ceiling for `score` (EU Cloud Sovereignty
 * Framework v1.2.1 calculator, "Max.Score(SOVn)"). Each objective's criteria
 * are DESIGNED to normalise to a nominal 1000 (SOV-1 8x125, SOV-2 6x167,
 * SOV-3 5x200, SOV-4 6x167, SOV-5 7x143, SOV-6 5x200, SOV-7 7x143, SOV-8
 * 4x250 = 48 criteria total) — but 1000 is design intent, not arithmetic:
 * the workbook rounds each criterion's answer value to 2dp, so the actual
 * achievable total per objective differs slightly from 1000. Used by
 * computeSovereigntyScore as the default GUARD ceiling for `score` when the
 * caller omits `maxScore` — see that function's doc comment for why this is
 * deliberately NOT also the default contribution divisor.
 */
export const SOV_MAX_SCORES: Record<string, number> = {
  "SOV-1": 1000.03,
  "SOV-2": 1002,
  "SOV-3": 1000,
  "SOV-4": 1002,
  "SOV-5": 1001,
  "SOV-6": 1000,
  "SOV-7": 1001,
  "SOV-8": 1000,
};

/**
 * Flat nominal divisor the EU CSF v1.2.1 calculator's own formula uses for
 * EVERY objective's percentage contribution (`Score(SOVn) / 1000 * weight`),
 * regardless of that objective's actual achievable ceiling (SOV_MAX_SCORES
 * above). Not exported: an internal implementation detail of
 * computeSovereigntyScore's default divisor, not a value callers set.
 */
const SOV_NOMINAL_MAX_SCORE = 1000;

/** SEAL0..SEAL4 rank, for comparing an achieved SEAL against a caller-supplied floor. */
const SEAL_RANK: Record<string, number> = {
  "SEAL0": 0,
  "SEAL1": 1,
  "SEAL2": 2,
  "SEAL3": 3,
  "SEAL4": 4,
};

/**
 * SEAL0..SEAL4 English (EU Cloud Sovereignty Framework v1.2.1 Implementation
 * guidance p.2-3, p.10) + official Dutch labels (NDS Cloudprogramma notitie,
 * "Verkenning Overheidsbrede Soevereine Clouddiensten", 11 juni 2026, Tabel 1
 * p.8).
 *
 * SEAL3's English and Dutch names are a DELIBERATE, VERIFIED divergence, not
 * a bug: the Commission names SEAL3 "Technological sovereignty" (guidance
 * p.2-3, p.10), while NDS's Dutch table renders it "Digitale veerkracht"
 * ("digital resilience") — a faithful verbatim quotation of the Dutch
 * source, which does NOT translate the Commission's English name. Do not
 * "fix" the Dutch to match the English, or vice versa; anyone reconciling a
 * Dutch assessment against an EU one needs to know these are the same rung
 * under two different names. The same divergence pattern recurs in the
 * level *descriptions* (not carried in this lookup table today): NDS's
 * Dutch reads "EU-wetgeving is van toepassing en afdwingbaar" ("EU law is
 * applicable and enforceable") where the Commission's English reads "EU
 * jurisdictions apply" — where this codebase carries English descriptions
 * in future, prefer the Commission's English wording; where it carries
 * Dutch, keep NDS's.
 */
export const SEAL_LABELS: Record<string, { en: string; nl: string }> = {
  "SEAL0": { en: "No sovereignty", nl: "Geen soevereiniteit" },
  "SEAL1": {
    en: "Jurisdictional sovereignty",
    nl: "Jurisdictionele soevereiniteit",
  },
  "SEAL2": { en: "Data sovereignty", nl: "Data-soevereiniteit" },
  "SEAL3": { en: "Technological sovereignty", nl: "Digitale veerkracht" },
  "SEAL4": {
    en: "Full digital sovereignty",
    nl: "Volledige digitale soevereiniteit",
  },
};

// ---------- Herziening rijksbreed cloudbeleid 2026 (cloud eligibility) ------

/** NL rubricering ladder values (VIRBI 2025) accepted by evaluateCloudEligibility. */
const RUBRICERING_VALUES = [
  "Ongerubriceerd",
  "Dep. VERTROUWELIJK",
  "Stg. CONFIDENTIEEL",
  "Stg. GEHEIM",
  "Stg. ZEER GEHEIM",
] as const;

/** Te Beschermen Belang categories (TBB systematiek, Gereedschap v1.0, 2026-06-06). */
const TBB_VALUES = ["TBB 1", "TBB 2", "TBB 3", "TBB 4"] as const;

const STAATSGEHEIM_RUBRICERING = new Set<string>([
  "Stg. CONFIDENTIEEL",
  "Stg. GEHEIM",
  "Stg. ZEER GEHEIM",
]);

const PROHIBITED_TBB = new Set<string>(["TBB 1", "TBB 2", "TBB 3"]);

/** Regions treated as satisfying the cloud policy's EEA+Switzerland residency requirement. */
function isEeaOrSwitzerlandRegion(region: string): boolean {
  return region === "EEA" || region === "Switzerland";
}

/** Supplier jurisdictions treated as EU/EEA-compliant for clause 4.3. */
function isEuEeaSupplierJurisdiction(jurisdiction: string): boolean {
  return jurisdiction === "EU" || jurisdiction === "EEA" ||
    jurisdiction === "Switzerland";
}

// ---------- Resource schemas -------------------------------------------------

const ArtifactSchema = z.object({
  file: z.string(),
  relPath: z.string(),
  projectId: z.string(),
  docType: z.string(),
  command: z.string().optional(),
  instance: z.number().optional(),
  version: z.string(),
  format: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.string().optional(),
});

const ProjectSchema = z.object({
  dir: z.string(),
  id: z.string(),
  name: z.string(),
  isGlobal: z.boolean(),
  artifactCount: z.number(),
  artifacts: z.array(ArtifactSchema),
  otherMarkdownCount: z.number(),
});

const WorkspaceSchema = z.object({
  path: z.string(),
  projectCount: z.number(),
  artifactCount: z.number(),
  unmappedDocTypes: z.array(z.string()),
  projects: z.array(ProjectSchema),
  scannedAt: z.string(),
});

const ViolationSchema = z.object({
  command: z.string(),
  missingMandatory: z.array(z.string()),
});

const ProjectGapsSchema = z.object({
  dir: z.string(),
  id: z.string(),
  name: z.string(),
  present: z.array(z.string()),
  violations: z.array(ViolationSchema),
  violationCount: z.number(),
  nextOnCriticalPath: z.string().optional(),
  criticalPathDone: z.number(),
  criticalPathTotal: z.number(),
});

const GapsSchema = z.object({
  path: z.string(),
  globalCommands: z.array(z.string()),
  projects: z.array(ProjectGapsSchema),
  summary: z.object({
    projectCount: z.number(),
    projectsWithViolations: z.number(),
    totalViolations: z.number(),
  }),
  analyzedAt: z.string(),
});

const InitResultSchema = z.object({
  path: z.string(),
  created: z.array(z.string()),
  existing: z.array(z.string()),
  initializedAt: z.string(),
});

const ProjectStateSchema = z.object({
  projectDir: z.string(),
  id: z.string(),
  title: z.string(),
  profile: z.enum(PROFILES),
  state: z.enum(PROJECT_STATES),
  skipped: z.array(z.object({
    phase: z.string(),
    reason: z.string(),
    at: z.string(),
  })).default([]),
  history: z.array(z.object({
    from: z.string(),
    to: z.string(),
    via: z.enum(["start", "advance", "skip", "abandon"]),
    at: z.string(),
    note: z.string().optional(),
  })).default([]),
  abandonReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const GateGroupSchema = z.object({
  anyOf: z.array(z.string()),
  satisfied: z.boolean(),
  satisfiedBy: z.string().optional(),
});

const NextActionSchema = z.object({
  command: z.string(),
  docCode: z.string().optional(),
  templateFile: z.string().optional(),
  suggestedFilename: z.string().optional(),
  mandatoryInputs: z.array(z.string()),
  alternatives: z.array(z.string()),
});

const ProjectStatusSchema = z.object({
  projectDir: z.string(),
  id: z.string(),
  title: z.string(),
  profile: z.string(),
  state: z.string(),
  phaseIndex: z.number(),
  phaseCount: z.number(),
  gate: z.array(GateGroupSchema),
  gateSatisfied: z.boolean(),
  skippable: z.boolean(),
  presentCommands: z.array(z.string()),
  artifactCount: z.number(),
  nextAction: NextActionSchema.optional(),
  skipped: z.array(z.object({
    phase: z.string(),
    reason: z.string(),
    at: z.string(),
  })),
  statusAt: z.string(),
});

const TemplateCatalogSchema = z.object({
  templateCount: z.number(),
  templates: z.array(z.object({
    command: z.string(),
    docCode: z.string().optional(),
    file: z.string(),
    sizeBytes: z.number(),
  })),
  partials: z.array(z.string()),
  unmappedFiles: z.array(z.string()).default([]),
  listedAt: z.string(),
});

const TemplateDocSchema = z.object({
  command: z.string(),
  docCode: z.string().optional(),
  templateFile: z.string(),
  targetDir: z.string().optional(),
  suggestedFilename: z.string().optional(),
  mandatoryInputs: z.array(z.string()),
  content: z.string(),
  fetchedAt: z.string(),
});

const ProvisionResultSchema = z.object({
  path: z.string(),
  targetDir: z.string(),
  written: z.array(z.string()),
  fileCount: z.number(),
  provisionedAt: z.string(),
});

// Exported (unlike most resource schemas in this file) so a pre-2026.08.06.1
// (no `ladder` key) classificationMigration record's backward-compatible
// parse can be pinned directly by a test — see MigrationSchema.ladder's
// `.default("uae")` comment.
export const MigrationSchema = z.object({
  path: z.string(),
  apply: z.boolean(),
  // Defaulted (like `skipped` below) so a pre-2026.08.06.1 classificationMigration
  // record — written before this field existed, necessarily by the only
  // ladder that existed then — still parses. classificationMigration is
  // lifetime "infinite" with garbageCollection 5, so old records persist and
  // can be restored from the datastore; a required field here would break them.
  ladder: z.enum(CLASSIFICATION_LADDER_NAMES).default("uae"),
  scannedFiles: z.number(),
  files: z.array(z.object({
    relPath: z.string(),
    changes: z.array(z.object({ from: z.string(), to: z.string() })),
  })),
  totalChanges: z.number(),
  skipped: z.array(z.object({ relPath: z.string(), reason: z.string() }))
    .default([]),
  ranAt: z.string(),
});

const SovereigntyBreakdownEntrySchema = z.object({
  id: z.string(),
  weight: z.number(),
  contribution: z.number(),
  seal: z.string().optional(),
  evidence: z.string().optional(),
});

const SovereigntyAssessmentSchema = z.object({
  subject: z.string(),
  project: z.string().optional(),
  score: z.number(),
  breakdown: z.array(SovereigntyBreakdownEntrySchema),
  floorsEvaluated: z.boolean(),
  floorsPassed: z.boolean(),
  objectivesBelowFloor: z.array(z.string()),
  // The framework's actual rejection gate (guidance p.9): the LOWEST SEAL
  // achieved across all eight objectives, never an average or a mode.
  // undefined — NOT fabricated as SEAL0 — when any objective has no
  // recorded SEAL.
  overallSeal: z.string().optional(),
  // Every objective id whose SEAL equals overallSeal (a tie is possible).
  overallSealGovernedBy: z.array(z.string()),
  assessedAt: z.string(),
});

const Clause45Schema = z.object({
  continuityEstablishedIndependently: z.boolean(),
  riskAnalysisAndExitPlanTested: z.boolean(),
  ministerialApprovalObtained: z.boolean(),
  allMet: z.boolean(),
});

const CloudEligibilitySchema = z.object({
  subject: z.string(),
  project: z.string().optional(),
  verdict: z.enum(["allowed", "conditional", "discouraged", "prohibited"]),
  clauses: z.array(z.string()),
  reason: z.string(),
  clause45: Clause45Schema.optional(),
  evaluatedAt: z.string(),
});

// ---------- Pure logic (exported for tests) -----------------------------------

const ARTIFACT_RE = /^ARC-(\d{3})-(.+)-v(\d+(?:\.\d+)*)\.(md|json|html)$/;

/**
 * Parse an ArcKit artifact filename like `ARC-001-PRIN-COMP-v1.0.md`.
 * Returns null when the name doesn't follow the ARC naming convention.
 * Hyphenated codes match longest-first (PRIN-COMP before PRIN); a trailing
 * `-{N}` on a known code is a multi-instance number (e.g. DFD-2).
 */
export function parseArtifactFilename(filename: string): {
  projectId: string;
  docType: string;
  command?: string;
  instance?: number;
  version: string;
  format: string;
} | null {
  const m = filename.match(ARTIFACT_RE);
  if (!m) return null;
  const [, projectId, middle, version, format] = m;
  for (const code of CODES_BY_LENGTH) {
    if (middle === code) {
      return {
        projectId,
        docType: code,
        command: DOC_CODES[code],
        version,
        format,
      };
    }
    if (middle.startsWith(code + "-")) {
      const rest = middle.slice(code.length + 1);
      if (/^\d+$/.test(rest)) {
        return {
          projectId,
          docType: code,
          command: DOC_CODES[code],
          instance: Number(rest),
          version,
          format,
        };
      }
    }
  }
  return { projectId, docType: middle, version, format };
}

/** Parse a `NNN-name` project directory name; null when not a project dir. */
export function parseProjectDir(
  dirname: string,
): { id: string; name: string; isGlobal: boolean } | null {
  // LB5: `\d{3,}` (3-OR-MORE) — nextProjectDir's zero-padding stays 3-digit
  // for ids <=999, but this parser must also accept the 4+ digit ids that
  // padStart naturally produces once the allocation counter passes 999.
  const m = dirname.match(/^(\d{3,})-(.+)$/);
  if (!m) return null;
  return { id: m[1], name: m[2], isGlobal: m[1] === "000" };
}

/**
 * Mandatory-dependency and critical-path analysis over scanned projects.
 * Commands present in the 000-global project (typically principles) satisfy
 * dependencies for every project. The global project itself is not listed.
 */
export function computeGaps(
  input: Array<{
    dir: string;
    id: string;
    name: string;
    isGlobal: boolean;
    commands: string[];
  }>,
): {
  globalCommands: string[];
  projects: Array<z.infer<typeof ProjectGapsSchema>>;
  summary: {
    projectCount: number;
    projectsWithViolations: number;
    totalViolations: number;
  };
} {
  const globalCommands = new Set<string>();
  for (const p of input) {
    if (p.isGlobal) p.commands.forEach((c) => globalCommands.add(c));
  }

  const projects = input.filter((p) => !p.isGlobal).map((p) => {
    const present = [...new Set(p.commands)].sort();
    const effective = new Set([...present, ...globalCommands]);
    const violations: Array<z.infer<typeof ViolationSchema>> = [];
    for (const command of present) {
      const deps = MANDATORY_DEPS[command];
      if (!deps) continue;
      const missingMandatory = deps.filter((d) => !effective.has(d));
      if (missingMandatory.length) {
        violations.push({ command, missingMandatory });
      }
    }
    return {
      dir: p.dir,
      id: p.id,
      name: p.name,
      present,
      violations,
      violationCount: violations.length,
      nextOnCriticalPath: CRITICAL_PATH.find((s) => !effective.has(s)),
      criticalPathDone: CRITICAL_PATH.filter((s) => effective.has(s)).length,
      criticalPathTotal: CRITICAL_PATH.length,
    };
  });

  return {
    globalCommands: [...globalCommands].sort(),
    projects,
    summary: {
      projectCount: projects.length,
      projectsWithViolations: projects.filter((p) => p.violationCount > 0)
        .length,
      totalViolations: projects.reduce((n, p) => n + p.violationCount, 0),
    },
  };
}

// ---------- State-machine pure logic (exported for tests) ---------------------

/** Kebab-case a project title into a directory slug. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "project";
}

/** Allocate the next NNN-slug project directory name (000 is reserved). */
export function nextProjectDir(existingDirs: string[], slug: string): string {
  let max = 0;
  for (const dir of existingDirs) {
    const parsed = parseProjectDir(dir);
    if (parsed) max = Math.max(max, Number(parsed.id));
  }
  return `${String(max + 1).padStart(3, "0")}-${slug}`;
}

/** The gate groups for a phase under a profile (base + profile extras). */
export function gateFor(phase: string, profile: string): string[][] {
  const base = PHASE_GATES[phase];
  if (!base) return [];
  const extras = PROFILE_EXTRAS[profile]?.[phase] ?? [];
  return [...base.groups, ...extras];
}

/**
 * Evaluate a phase gate against the commands present on disk. Every group
 * must have at least one member present.
 */
export function evaluateGate(
  present: Iterable<string>,
  phase: string,
  profile: string,
): {
  satisfied: boolean;
  groups: Array<z.infer<typeof GateGroupSchema>>;
} {
  const have = new Set(present);
  const groups = gateFor(phase, profile).map((anyOf) => {
    const satisfiedBy = anyOf.find((c) => have.has(c));
    return { anyOf, satisfied: satisfiedBy !== undefined, satisfiedBy };
  });
  return { satisfied: groups.every((g) => g.satisfied), groups };
}

/** The phase after `current`, or "complete" past the last one. */
export function nextPhase(current: string): string {
  const idx = PHASES.indexOf(current as (typeof PHASES)[number]);
  if (idx === -1 || idx === PHASES.length - 1) return "complete";
  return PHASES[idx + 1];
}

/**
 * Port of arc-kit's migrate_classification.py: rewrite Document Control
 * `| **Classification** | <UK value> |` lines to the target ladder (default
 * "uae", the UAE Smart Data ladder; "nl" is the NL rubricering ladder). The
 * source vocabulary (the CLASSIFICATION_LINE regex) is shared across every
 * ladder — only the target table varies — so a value outside the fixed UK
 * source vocabulary never matches and produces no entry, under any ladder.
 *
 * A source value with NO target in the selected ladder's table (today: only
 * OFFICIAL / OFFICIAL-SENSITIVE under ladder="nl" — see
 * NL_CLASSIFICATION_MAPPING's doc comment) is never guessed: the line is
 * left byte-unchanged, contributes no `changes` entry, and is reported in
 * `requiresDecision` instead. Under ladder="uae" every source value has a
 * target, so `requiresDecision` is always empty — behavior is unchanged.
 */
export function proposeClassification(text: string, ladder: string = "uae"): {
  newText: string;
  changes: Array<{ from: string; to: string }>;
  requiresDecision: Array<{ value: string }>;
} {
  const table = CLASSIFICATION_LADDERS[ladder];
  if (!table) {
    throw new Error(
      `Unknown classification ladder "${ladder}". Registered ladders: ${
        Object.keys(CLASSIFICATION_LADDERS).sort().join(", ")
      }`,
    );
  }
  const changes: Array<{ from: string; to: string }> = [];
  const requiresDecision: Array<{ value: string }> = [];
  const newText = text.replace(
    CLASSIFICATION_LINE,
    (m, pre, value, post) => {
      const mapped = table[value];
      if (mapped === undefined) {
        if (
          (NL_REQUIRES_EXPLICIT_DECISION as readonly string[]).includes(
            value,
          )
        ) {
          requiresDecision.push({ value });
        }
        // No table entry and not a known requires-decision value: never
        // invent a mapping — leave byte-unchanged, no changes entry either.
        return m;
      }
      changes.push({ from: value, to: mapped });
      return `${pre}${mapped}${post}`;
    },
  );
  return { newText, changes, requiresDecision };
}

/**
 * EU Cloud Sovereignty Framework v1.2.1: score eight weighted Sovereignty
 * Objectives (SOV-1..SOV-8, weights 20/10/10/15/10/15/15/5, summing to 100).
 *
 * `maxScore` is OPTIONAL per objective and plays TWO roles that are the SAME
 * number only when the caller supplies it explicitly:
 *
 *  - GUARD ceiling: the highest `score` this function accepts for that
 *    objective. Defaults to SOV_MAX_SCORES[id] (the objective's actual
 *    achievable maximum per the calculator) when omitted.
 *  - CONTRIBUTION DIVISOR: `contribution = round((score/divisor)*weight, 2)`.
 *    Defaults to the flat nominal 1000 (SOV_NOMINAL_MAX_SCORE) when omitted
 *    — the calculator's own formula divides every objective by the SAME
 *    1000, never by that objective's true ceiling.
 *
 * A caller who omits `maxScore` and scores an objective at its true ceiling
 * (e.g. SOV-2 at 1002) is therefore ACCEPTED (1002 <= SOV_MAX_SCORES["SOV-2"])
 * but still divides by 1000, not 1002 — reproducing the calculator's own
 * faithful behaviour that a maximal response across all eight objectives
 * scores just OVER 100% (100.0756%), never capped at 100%. This is a
 * documented property of the framework's formula, not a bug introduced
 * here: the workbook rounds each criterion's answer value to 2dp, so the
 * per-objective criteria total lands slightly above 1000 for five of the
 * eight objectives, while the calculator's divisor stays a flat 1000 —
 * reporting that faithfully beats forcing a tidy 100% ceiling. If the
 * caller supplies `maxScore` explicitly, it is honoured for BOTH roles
 * exactly as before FIX 4 — the defaulting above only applies when it is
 * omitted.
 *
 * SEAL is NOT an input to this score, and never derives from it either:
 * guidance p.9 — "The same answers are used to determine the SEAL of each
 * row, with each answer defining the SEAL level of the question." Score and
 * SEAL are two parallel readings of the same 48 criteria answers; treating
 * one as computed FROM the other is the misreading this formula invites.
 *
 * FAIL-CLOSED — `objectives` must contain EXACTLY the eight known ids, each
 * EXACTLY once: rejects a missing objective, a DUPLICATE objective id (the
 * array must not name the same objective twice — a later duplicate silently
 * overriding an earlier one is a fail-open shape this function refuses), an
 * UNRECOGNIZED objective id (one outside SOV-1..SOV-8), a negative score, a
 * score exceeding its (resolved) maxScore, or a resolved maxScore <= 0.
 * Per-objective SEAL floors are CALLER-SUPPLIED (never hardcoded — the
 * framework states the tender specification defines the minimum SEAL per
 * objective); when supplied, every objective whose achieved SEAL falls
 * below its floor is named in `objectivesBelowFloor`.
 *
 * `overallSeal` is the framework's ACTUAL rejection gate (guidance p.9:
 * "The overall SEAL level is the lowest SEAL level achieved in any of the
 * objectives" — calculator cell F2: `="SEAL-"&MIN(H5:H251)`) — a MINIMUM,
 * never an average or a mode, across all eight objectives' achieved SEALs.
 * `undefined` — NEVER fabricated as SEAL0 — when any objective has no
 * recorded SEAL, since that would silently manufacture a gate failure.
 * `overallSealGovernedBy` names every objective id whose SEAL equals that
 * minimum (a tie is possible).
 */
export function computeSovereigntyScore(input: {
  objectives: Array<
    {
      id: string;
      score: number;
      maxScore?: number;
      seal?: string;
      evidence?: string;
    }
  >;
  sealFloors?: Record<string, string>;
}): {
  score: number;
  breakdown: Array<
    {
      id: string;
      weight: number;
      contribution: number;
      seal?: string;
      evidence?: string;
    }
  >;
  floorsEvaluated: boolean;
  floorsPassed: boolean;
  objectivesBelowFloor: string[];
  overallSeal: string | undefined;
  overallSealGovernedBy: string[];
} {
  const seenIds = new Set<string>();
  for (const o of input.objectives) {
    if (!SOV_ID_SET.has(o.id)) {
      throw new Error(
        `computeSovereigntyScore: unrecognized objective "${o.id}" — objectives must be exactly ${
          SOV_IDS.join(", ")
        }`,
      );
    }
    if (seenIds.has(o.id)) {
      throw new Error(
        `computeSovereigntyScore: duplicate objective "${o.id}" — objectives must be exactly ${
          SOV_IDS.join(", ")
        }, each exactly once`,
      );
    }
    seenIds.add(o.id);
  }
  const byId = new Map(input.objectives.map((o) => [o.id, o]));
  for (const id of SOV_IDS) {
    const o = byId.get(id);
    if (!o) {
      throw new Error(
        `computeSovereigntyScore: missing objective "${id}" — objectives must be exactly ${
          SOV_IDS.join(", ")
        }`,
      );
    }
    // Guard ceiling: caller-supplied maxScore, or the objective's actual
    // achievable maximum — NOT the flat nominal 1000 (see doc comment).
    const guardMax = o.maxScore ?? SOV_MAX_SCORES[id];
    if (o.score < 0) {
      throw new Error(
        `computeSovereigntyScore: objective "${id}" has a negative score (${o.score})`,
      );
    }
    if (guardMax <= 0) {
      throw new Error(
        `computeSovereigntyScore: objective "${id}" has maxScore <= 0 (${guardMax})`,
      );
    }
    if (o.score > guardMax) {
      throw new Error(
        `computeSovereigntyScore: objective "${id}" score (${o.score}) exceeds maxScore (${guardMax})`,
      );
    }
    if (o.seal !== undefined && !(o.seal in SEAL_RANK)) {
      throw new Error(
        `computeSovereigntyScore: objective "${id}" has an unrecognized SEAL "${o.seal}". Valid: ${
          Object.keys(SEAL_RANK).join(", ")
        }`,
      );
    }
  }

  const breakdown = SOV_IDS.map((id) => {
    const o = byId.get(id)!;
    const weight = SOV_WEIGHTS[id];
    // Contribution divisor: caller-supplied maxScore when given (honoured
    // exactly as before FIX 4), or else the flat nominal 1000 — NEVER
    // SOV_MAX_SCORES[id] by default (that would force every maximal
    // response to exactly 100%, which is not how the calculator's own
    // formula behaves).
    const divisor = o.maxScore ?? SOV_NOMINAL_MAX_SCORE;
    const contribution = Math.round((o.score / divisor) * weight * 100) /
      100;
    return { id, weight, contribution, seal: o.seal, evidence: o.evidence };
  });
  const score = Math.round(
    breakdown.reduce((sum, b) => sum + b.contribution, 0) * 100,
  ) / 100;

  const floorsEvaluated = input.sealFloors !== undefined;
  const objectivesBelowFloor: string[] = [];
  if (floorsEvaluated) {
    for (const [id, floor] of Object.entries(input.sealFloors!)) {
      const floorRank = SEAL_RANK[floor];
      if (floorRank === undefined) {
        throw new Error(
          `computeSovereigntyScore: unrecognized SEAL floor "${floor}" for objective "${id}". Valid: ${
            Object.keys(SEAL_RANK).join(", ")
          }`,
        );
      }
      const o = byId.get(id);
      const achievedRank = o?.seal !== undefined ? SEAL_RANK[o.seal] : -1;
      if (achievedRank < floorRank) objectivesBelowFloor.push(id);
    }
  }

  // overallSeal: the framework's actual gate, a MINIMUM — never fabricated
  // when any objective lacks a recorded SEAL.
  let overallSeal: string | undefined;
  let overallSealGovernedBy: string[] = [];
  const allSealed = SOV_IDS.every((id) => byId.get(id)!.seal !== undefined);
  if (allSealed) {
    let minRank = Infinity;
    for (const id of SOV_IDS) {
      const rank = SEAL_RANK[byId.get(id)!.seal!];
      if (rank < minRank) minRank = rank;
    }
    overallSeal = Object.keys(SEAL_RANK).find((s) => SEAL_RANK[s] === minRank);
    overallSealGovernedBy = SOV_IDS.filter((id) =>
      SEAL_RANK[byId.get(id)!.seal!] === minRank
    );
  }

  return {
    score,
    breakdown,
    floorsEvaluated,
    floorsPassed: !floorsEvaluated || objectivesBelowFloor.length === 0,
    objectivesBelowFloor,
    overallSeal,
    overallSealGovernedBy,
  };
}

const CLOUD_ELIGIBILITY_REQUIRED_KEYS = [
  "processingRegion",
  "supplierJurisdiction",
  "isPrimaryProcess",
  "isBasisregistratie",
  "isEmailOrWorkplace",
  "continuityEstablishedIndependently",
  "riskAnalysisAndExitPlanTested",
  "ministerialApprovalObtained",
  "isVitaleAanbieder",
  "isWwkeEntity",
  "isCbwEssentialEntity",
] as const;

const CLOUD_ELIGIBILITY_VERDICT_RANK: Record<string, number> = {
  "allowed": 0,
  "discouraged": 1,
  "conditional": 2,
  "prohibited": 3,
};

/**
 * Herziening rijksbreed cloudbeleid 2026: evaluate whether public-cloud use
 * is allowed | conditional | discouraged | prohibited. STRICT TOTAL ORDER —
 * prohibited > conditional > discouraged > allowed — resolved as the maximum
 * over EVERY fired rule (never first-match), with every fired clause
 * returned. FAIL-CLOSED: every governance input is required with no
 * permissive default; rubricering/tbbCategory (at least one required) are
 * rejected when unrecognized, listing the valid set.
 */
export function evaluateCloudEligibility(input: {
  rubricering?: string;
  tbbCategory?: string;
  processingRegion: string;
  supplierJurisdiction: string;
  isPrimaryProcess: boolean;
  isBasisregistratie: boolean;
  isEmailOrWorkplace: boolean;
  continuityEstablishedIndependently: boolean;
  riskAnalysisAndExitPlanTested: boolean;
  ministerialApprovalObtained: boolean;
  isVitaleAanbieder: boolean;
  isWwkeEntity: boolean;
  isCbwEssentialEntity: boolean;
}): {
  verdict: "allowed" | "conditional" | "discouraged" | "prohibited";
  clauses: string[];
  reason: string;
  clause45?: {
    continuityEstablishedIndependently: boolean;
    riskAnalysisAndExitPlanTested: boolean;
    ministerialApprovalObtained: boolean;
    allMet: boolean;
  };
} {
  if (input.rubricering === undefined && input.tbbCategory === undefined) {
    throw new Error(
      "evaluateCloudEligibility: at least one of rubricering or tbbCategory is required",
    );
  }
  const raw = input as unknown as Record<string, unknown>;
  for (const key of CLOUD_ELIGIBILITY_REQUIRED_KEYS) {
    if (raw[key] === undefined) {
      throw new Error(
        `evaluateCloudEligibility: required argument "${key}" is missing`,
      );
    }
  }
  if (
    input.rubricering !== undefined &&
    !(RUBRICERING_VALUES as readonly string[]).includes(input.rubricering)
  ) {
    throw new Error(
      `evaluateCloudEligibility: unrecognized rubricering "${input.rubricering}". Valid values: ${
        RUBRICERING_VALUES.join(", ")
      }`,
    );
  }
  if (
    input.tbbCategory !== undefined &&
    !(TBB_VALUES as readonly string[]).includes(input.tbbCategory)
  ) {
    throw new Error(
      `evaluateCloudEligibility: unrecognized tbbCategory "${input.tbbCategory}". Valid values: ${
        TBB_VALUES.join(", ")
      }`,
    );
  }

  const fired: Array<
    { verdict: "conditional" | "discouraged" | "prohibited"; clause: string }
  > = [];

  if (input.rubricering && STAATSGEHEIM_RUBRICERING.has(input.rubricering)) {
    fired.push({
      verdict: "prohibited",
      clause:
        `Rijksbreed cloudbeleid 2026 §5.2 — staatsgeheim rubricering (${input.rubricering}) forbids public cloud`,
    });
  }
  if (input.tbbCategory && PROHIBITED_TBB.has(input.tbbCategory)) {
    fired.push({
      verdict: "prohibited",
      clause:
        `Rijksbreed cloudbeleid 2026 §5.2 — ${input.tbbCategory} forbids public cloud`,
    });
  }
  if (input.isBasisregistratie) {
    fired.push({
      verdict: "prohibited",
      clause:
        "Rijksbreed cloudbeleid 2026 §5.4 — basisregistratie source data may not be hosted on public cloud",
    });
  }
  if (!isEeaOrSwitzerlandRegion(input.processingRegion)) {
    fired.push({
      verdict: "prohibited",
      clause:
        `Rijksbreed cloudbeleid 2026 §4.6 — processing outside the EEA/Switzerland residency requirement (region: ${input.processingRegion})`,
    });
  }
  const entityFlagged = input.isVitaleAanbieder || input.isWwkeEntity ||
    input.isCbwEssentialEntity;
  if (
    entityFlagged && input.isPrimaryProcess &&
    !isEuEeaSupplierJurisdiction(input.supplierJurisdiction)
  ) {
    fired.push({
      verdict: "discouraged",
      clause:
        `Rijksbreed cloudbeleid 2026 §4.3 — vitale aanbieder / Wwke entity / Cbw essential entity using a non-EU/EEA supplier (${input.supplierJurisdiction}) for its primary process is advisory-discouraged`,
    });
  }

  let clause45: {
    continuityEstablishedIndependently: boolean;
    riskAnalysisAndExitPlanTested: boolean;
    ministerialApprovalObtained: boolean;
    allMet: boolean;
  } | undefined;
  if (input.isEmailOrWorkplace) {
    const allMet = input.continuityEstablishedIndependently &&
      input.riskAnalysisAndExitPlanTested && input.ministerialApprovalObtained;
    clause45 = {
      continuityEstablishedIndependently:
        input.continuityEstablishedIndependently,
      riskAnalysisAndExitPlanTested: input.riskAnalysisAndExitPlanTested,
      ministerialApprovalObtained: input.ministerialApprovalObtained,
      allMet,
    };
    if (!allMet) {
      fired.push({
        verdict: "conditional",
        clause:
          "Rijksbreed cloudbeleid 2026 §4.5 — email/workplace storage on public cloud requires all three conditions (continuity established independently, risk analysis + exit plan tested, ministerial approval obtained)",
      });
    }
  }

  let verdict: "allowed" | "conditional" | "discouraged" | "prohibited" =
    "allowed";
  for (const f of fired) {
    if (
      CLOUD_ELIGIBILITY_VERDICT_RANK[f.verdict] >
        CLOUD_ELIGIBILITY_VERDICT_RANK[verdict]
    ) {
      verdict = f.verdict;
    }
  }

  const clauses = fired.map((f) => f.clause);
  const verdictLabel = verdict[0].toUpperCase() + verdict.slice(1);
  const reason = clauses.length
    ? `${verdictLabel}: ${clauses.join(" ")}`
    : "Allowed: no Rijksbreed cloudbeleid 2026 restriction is triggered by the supplied governance facts.";

  return { verdict, clauses, reason, clause45 };
}

// ---------- Filesystem helpers -------------------------------------------------

async function listFilesRecursive(
  dir: string,
  rel = "",
  depth = 0,
): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".")) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const entryPath = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || depth >= 6) continue;
      out.push(
        ...await listFilesRecursive(entryPath, relPath, depth + 1),
      );
    } else if (entry.isFile) {
      out.push(relPath);
    } else if (entry.isSymlink) {
      // LB7: a symlinked artifact/directory must not be silently dropped.
      // Deno.stat follows the link to resolve the target's kind; the depth
      // cap above also bounds a symlink cycle when the target is a dir.
      let target: Deno.FileInfo;
      try {
        target = await Deno.stat(entryPath);
      } catch {
        continue; // broken symlink — nothing to inventory
      }
      if (target.isDirectory) {
        if (entry.name === "node_modules" || depth >= 6) continue;
        out.push(
          ...await listFilesRecursive(entryPath, relPath, depth + 1),
        );
      } else if (target.isFile) {
        out.push(relPath);
      }
    }
  }
  return out;
}

async function scanWorkspace(root: string) {
  const projectsDir = `${root}/projects`;
  const projects: Array<z.infer<typeof ProjectSchema>> = [];
  const unmapped = new Set<string>();
  let artifactCount = 0;

  let entries;
  try {
    entries = Deno.readDir(projectsDir);
  } catch (e) {
    throw new Error(
      `Not an ArcKit workspace: cannot read ${projectsDir} (${
        e instanceof Error ? e.message : e
      }). Run the init method first or check the configured path.`,
    );
  }

  for await (const entry of entries) {
    if (!entry.isDirectory && !entry.isSymlink) continue;
    if (entry.isSymlink) {
      // LB7: accept a symlinked project directory — confirm it resolves to
      // a directory before treating it as one (a symlinked FILE at this
      // level, or a broken link, is not a project).
      try {
        const target = await Deno.stat(`${projectsDir}/${entry.name}`);
        if (!target.isDirectory) continue;
      } catch {
        continue; // broken symlink
      }
    }
    const parsed = parseProjectDir(entry.name);
    if (!parsed) continue;

    const files = await listFilesRecursive(`${projectsDir}/${entry.name}`);
    const artifacts: Array<z.infer<typeof ArtifactSchema>> = [];
    let otherMarkdownCount = 0;
    for (const relPath of files.sort()) {
      const filename = relPath.split("/").pop() ?? relPath;
      const art = parseArtifactFilename(filename);
      if (!art) {
        if (filename.endsWith(".md")) otherMarkdownCount++;
        continue;
      }
      if (!art.command) unmapped.add(art.docType);
      let sizeBytes = 0;
      let modifiedAt: string | undefined;
      try {
        const stat = await Deno.stat(`${projectsDir}/${entry.name}/${relPath}`);
        sizeBytes = stat.size;
        modifiedAt = stat.mtime?.toISOString();
      } catch {
        // artifact listed but not statable; keep zero size
      }
      artifacts.push({
        file: filename,
        relPath,
        ...art,
        sizeBytes,
        modifiedAt,
      });
    }
    artifactCount += artifacts.length;
    projects.push({
      dir: entry.name,
      ...parsed,
      artifactCount: artifacts.length,
      artifacts,
      otherMarkdownCount,
    });
  }

  projects.sort((a, b) => a.dir.localeCompare(b.dir));
  return {
    path: root,
    projectCount: projects.length,
    artifactCount,
    unmappedDocTypes: [...unmapped].sort(),
    projects,
    scannedAt: new Date().toISOString(),
  };
}

// Directory skeleton `arckit init` creates (AI-assistant folders excluded —
// those belong to the ArcKit plugin, not the governance workspace).
const INIT_DIRS = [
  ".arckit/scripts/bash",
  ".arckit/templates",
  ".arckit/templates-custom",
  "projects/000-global",
  "projects/000-global/policies",
  "projects/000-global/external",
];

const GITKEEP_DIRS = [
  "projects/000-global",
  "projects/000-global/policies",
  "projects/000-global/external",
];

// Read a project's persisted lifecycle state (data name = project dir).
// LB4: `state` is now a closed enum (PROJECT_STATES) — a corrupted,
// hand-edited, or datastore-restored value outside it fails to parse here,
// the SOLE reader used by status/advance/skipPhase/abandon, rather than
// silently reaching gateFor/nextPhase and vacuously satisfying every gate.
async function readProjectState(context, projectDir: string) {
  const raw = await context.readResource!(projectDir);
  if (!raw) return null;
  try {
    return ProjectStateSchema.parse(raw);
  } catch (e) {
    const badState = (raw as Record<string, unknown>)?.state;
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Corrupted project state for ${projectDir}: invalid state "${badState}" (${detail})`,
    );
  }
}

// Commands present on disk for one project, with 000-global artifacts
// counting workspace-wide (principles etc.).
async function presentCommands(
  root: string,
  projectDir: string,
): Promise<Set<string>> {
  const snapshot = await scanWorkspace(root);
  const have = new Set<string>();
  for (const p of snapshot.projects) {
    if (p.dir !== projectDir && !p.isGlobal) continue;
    for (const a of p.artifacts) {
      if (a.command) have.add(a.command);
    }
  }
  return have;
}

// Next-action suggestion for the first unsatisfied gate group.
function suggestNextAction(
  groups: Array<z.infer<typeof GateGroupSchema>>,
  projectId: string,
): z.infer<typeof NextActionSchema> | undefined {
  const unsatisfied = groups.find((g) => !g.satisfied);
  if (!unsatisfied) return undefined;
  const command = unsatisfied.anyOf[0];
  const docCode = COMMAND_TO_CODE[command];
  return {
    command,
    docCode,
    templateFile: TEMPLATE_MAP[command],
    suggestedFilename: docCode
      ? `ARC-${projectId}-${docCode}-v1.0.md`
      : undefined,
    mandatoryInputs: MANDATORY_DEPS[command] ?? [],
    alternatives: unsatisfied.anyOf.slice(1),
  };
}

const TEMPLATES_DIR = "templates";

// ---------- Model ---------------------------------------------------------------

/**
 * `@magistr/arckit/workspace` — a standalone, skill-driven port of ArcKit
 * (the Enterprise Architecture Governance Harness) as swamp state.
 *
 * Workspace level: `init` scaffolds the skeleton, `provisionTemplates` copies
 * the bundled arc-kit templates into `.arckit/templates/`, `scan` inventories
 * every project's `ARC-*` artifacts, `gaps` checks the mandatory-dependency
 * matrix, and `migrateClassification` ports the Python CLI's UK→UAE
 * classification migration.
 *
 * Project level (the state machine — one governance project per state data
 * artifact, driven by the bundled `arckit` skill): `startProject` allocates
 * `projects/NNN-slug/` and enters `foundation`; `advance` gate-checks the
 * current phase against artifacts actually on disk before moving on;
 * `skipPhase` records an explicit bypass of a skippable phase; `status`
 * reports the gate, present artifacts, and the suggested next action
 * (command, template, target filename); `template` serves a bundled template
 * with its mandatory inputs; `abandon` closes a project from any state.
 *
 * Phases: foundation → context → risk → business-case → requirements →
 * design → procurement → design-review → delivery → operations → assurance →
 * story → complete. Profiles (standard | uk-gov | mod | ai) add gate groups
 * (e.g. uk-gov requires tcop + secure in assurance).
 */
export const model = {
  type: "@magistr/arckit/workspace",
  version: "2026.08.19.1",
  upgrades: [
    {
      fromVersion: "2026.07.16.2",
      toVersion: "2026.08.01.1",
      description:
        "LB1 startProject path-traversal confinement + five-suite characterization backfill; no resource-schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.01.1",
      toVersion: "2026.08.02.1",
      description:
        "LB2 atomic write + backup; LB3 defaulted maxFileBytes size cap; LB4 projectState.state enum; LB5 >999 id width; LB6 templates/provisionTemplates reconciliation (unmappedFiles); LB7 surface + write-guard symlinked artifacts. Defaulted global arg + defaulted resource-schema additions only; no data transformation.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.02.1",
      toVersion: "2026.08.06.1",
      description:
        'NL/EU sovereign-cloud overlay (arckit-nl-sovereign-cloud): nl-gov profile (risk +nl-tbb, design +nl-cloud, assurance +nl-bio/+nl-exit/+eu-sovereignty) widens the PROFILES enum; six new NL/EU doc codes + bundled templates (nl-tbb, nl-cloud, eu-sovereignty, nl-bio, nl-exit, nl-dtia); migrateClassification gains a `ladder` argument (default "uae", adds "nl" — the NL rubricering/VIRBI 2025 ladder) and MigrationSchema records which ladder ran; two new derived resources, sovereigntyAssessment (EU Cloud Sovereignty Framework v1.2.1 score) and cloudEligibility (Herziening rijksbreed cloudbeleid 2026 verdict). PROFILES widening is backward-compatible for reads and the new resource fields are additive — no data transformation needed.',
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.06.1",
      toVersion: "2026.08.07.1",
      description:
        'Closes two defects found by the pre-publish adversarial review of 2026.08.06.1, which was never published (the registry went 2026.08.02.1 -> 2026.08.07.1 directly): computeSovereigntyScore now rejects a duplicate or unrecognized objective id, not only a missing one — the guard was one-sided, so a repeated SOV-1 silently changed the computed score; and MigrationSchema.ladder gains a "uae" default so a classificationMigration record written before the ladder field existed still parses (that resource is lifetime "infinite", so such records persist and can be restored). Defaulting a previously-required field only widens what parses — no data transformation needed.',
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.07.1",
      toVersion: "2026.08.14.1",
      description:
        'Ports three verified upstream arc-kit defects in the EU Cloud Sovereignty Framework v1.2.1 implementation, found against the Commission\'s own Implementation guidance PDF and Annex calculator XLSX, plus one related backward-compatible widening: (1) SOV_WEIGHTS had three wrong values — SOV-1 15->20, SOV-5 20->10, SOV-7 10->15 — that happened to still sum to 100, which is exactly why this survived review; PREVIOUSLY-WRITTEN sovereigntyAssessment records were scored against the wrong weights and are NOT recomputed by this upgrade (that resource is lifetime "infinite" — re-run euSovereigntyScore for any assessment that still matters). (2) SEAL_LABELS.SEAL3.en corrected "Digital resilience" -> "Technological sovereignty" (guidance p.2-3, p.10); SEAL_LABELS.SEAL3.nl is UNCHANGED — "Digitale veerkracht" is a verified, deliberate divergence from the Commission\'s English name, quoted verbatim from the NDS Cloudprogramma notitie, not a bug. (3) computeSovereigntyScore now also returns overallSeal (the minimum SEAL across all eight objectives — the framework\'s actual rejection gate, guidance p.9 — undefined, never fabricated as SEAL0, when any objective lacks a recorded SEAL) and overallSealGovernedBy (which objective(s) achieve that minimum); SovereigntyAssessmentSchema gains both fields. (4) objectives[].maxScore is now optional, defaulting per-objective to the new exported SOV_MAX_SCORES (the calculator\'s actual per-objective ceiling, 1000-1002 depending on objective, due to workbook rounding) for the accept/reject guard, while the contribution divisor stays the calculator\'s flat nominal 1000 unless maxScore is supplied explicitly — reproducing the calculator\'s own documented behaviour that a maximal response scores 100.0756%, not 100%. All four changes are additive/corrective to the resource shape, not a data-shape break — identity migration; no data transformation needed.',
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.19.1",
      description: "Version bump and smoke test",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    workspace: {
      description:
        "Inventory of the ArcKit workspace: every project directory with its parsed ARC-* artifacts (doc type, producing command, version, size, mtime).",
      schema: WorkspaceSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    gaps: {
      description:
        "Governance-gap analysis per project: mandatory-dependency violations, commands present, and the next step on the standard critical path.",
      schema: GapsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    initResult: {
      description:
        "Result of workspace scaffolding: which skeleton directories were created vs already present.",
      schema: InitResultSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    projectState: {
      description:
        "Lifecycle state of one governance project (data name = project dir): current phase, profile, skipped phases, and full transition history. Persists across sessions.",
      schema: ProjectStateSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    projectStatus: {
      description:
        "Compact per-project status written by the status method: current gate with satisfaction per group, present commands, and the suggested next action (command, template, target filename). Derived — non-authoritative.",
      schema: ProjectStatusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    templateCatalog: {
      description:
        "Catalog of the bundled arc-kit templates: command, doc code, file, size.",
      schema: TemplateCatalogSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    templateDoc: {
      description:
        "One bundled template's full content plus its doc code, suggested target filename, and mandatory input artifacts.",
      schema: TemplateDocSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    provisionResult: {
      description:
        "Result of copying the bundled templates into the workspace's .arckit/templates/ directory.",
      schema: ProvisionResultSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    classificationMigration: {
      description:
        "Report (or applied result) of a classification ladder migration (uae or nl) across all ARC-* artifacts.",
      schema: MigrationSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    sovereigntyAssessment: {
      description:
        "EU Cloud Sovereignty Framework v1.2.1 score for one subject (service or provider): per-objective (SOV-1..SOV-8) weighted contribution, total score, overallSeal (the framework's actual rejection gate — the minimum SEAL across all eight objectives, undefined if any objective has no recorded SEAL) with overallSealGovernedBy naming which objective(s) achieve it, and — when caller-supplied SEAL floors were given — pass/fail per objective. An assessment record, not a certification.",
      schema: SovereigntyAssessmentSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    cloudEligibility: {
      description:
        "Herziening rijksbreed cloudbeleid 2026 public-cloud eligibility verdict for one subject: allowed | conditional | discouraged | prohibited, every fired clause, and a human-readable reason.",
      schema: CloudEligibilitySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    init: {
      description:
        "Idempotently scaffold the ArcKit workspace skeleton (.arckit/ and projects/000-global/) at the configured path. Existing directories are left untouched and reported.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const root = context.globalArgs.path;
        const created: string[] = [];
        const existing: string[] = [];
        for (const dir of INIT_DIRS) {
          const full = `${root}/${dir}`;
          try {
            const stat = await Deno.stat(full);
            if (stat.isDirectory) {
              existing.push(dir);
              continue;
            }
            throw new Error(`${full} exists but is not a directory`);
          } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) throw e;
          }
          await Deno.mkdir(full, { recursive: true });
          created.push(dir);
        }
        for (const dir of GITKEEP_DIRS) {
          const keep = `${root}/${dir}/.gitkeep`;
          try {
            await Deno.stat(keep);
          } catch {
            await Deno.writeTextFile(keep, "");
          }
        }
        const handle = await context.writeResource("initResult", "init", {
          path: root,
          created,
          existing,
          initializedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    scan: {
      description:
        "Inventory the whole workspace in one run: every projects/NNN-name directory, its ARC-* artifacts parsed into doc type / command / version, with file size and mtime.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const snapshot = await scanWorkspace(context.globalArgs.path);
        const handle = await context.writeResource(
          "workspace",
          "workspace",
          snapshot,
        );
        return { dataHandles: [handle] };
      },
    },

    gaps: {
      description:
        "Rescan the workspace and evaluate every project against ArcKit's mandatory-dependency matrix: violations (artifact present, mandatory input missing), commands present, and next critical-path step. Global (000-global) artifacts satisfy dependencies workspace-wide.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const root = context.globalArgs.path;
        const snapshot = await scanWorkspace(root);
        const analysis = computeGaps(snapshot.projects.map((p) => ({
          dir: p.dir,
          id: p.id,
          name: p.name,
          isGlobal: p.isGlobal,
          commands: p.artifacts.map((a) => a.command).filter(
            (c): c is string => typeof c === "string",
          ),
        })));
        const handle = await context.writeResource("gaps", "gaps", {
          path: root,
          ...analysis,
          analyzedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    startProject: {
      description:
        "Start a governance project: allocate the next projects/NNN-slug directory (or adopt an explicit dir), create it, and enter the foundation phase. Refuses to restart a project that is already in flight.",
      arguments: z.object({
        title: z.string().describe("Human project title"),
        profile: z.enum(PROFILES).default("standard").describe(
          "Governance profile — adds gate groups (uk-gov: tcop+secure, mod: mod-secure, ai: data-model+ai-playbook+atrs)",
        ),
        dir: z.string().optional().describe(
          "Explicit NNN-slug project directory (allocated from the title when omitted)",
        ),
      }),
      execute: async (args, context) => {
        const root = context.globalArgs.path;
        await Deno.mkdir(`${root}/projects`, { recursive: true });
        const existing: string[] = [];
        for await (const e of Deno.readDir(`${root}/projects`)) {
          if (e.isDirectory) existing.push(e.name);
        }
        const dir = args.dir ?? nextProjectDir(existing, slugify(args.title));
        const parsed = parseProjectDir(dir);
        if (!parsed) {
          throw new Error(
            `Project dir must match NNN-slug (got "${dir}")`,
          );
        }
        if (parsed.isGlobal) {
          throw new Error("000 is reserved for the global project");
        }
        // LB5: `\d{3,}` widens past the 999 boundary in lockstep with
        // parseProjectDir — the character class still forbids `/`, `\`,
        // `.`, so every LB1 traversal payload stays rejected.
        if (!/^\d{3,}-[a-z0-9-]+$/.test(dir)) {
          throw new Error(
            `Project dir must be a single NNN-slug segment (letters, digits, hyphens only) (got "${dir}")`,
          );
        }
        const prior = await readProjectState(context, dir);
        if (prior && prior.state !== "abandoned") {
          throw new Error(
            `Project ${dir} already started (state: ${prior.state}). Use status/advance, or abandon it first.`,
          );
        }
        await Deno.mkdir(`${root}/projects/${dir}`, { recursive: true });
        const at = new Date().toISOString();
        context.logger.info("Starting governance project {dir} ({profile})", {
          dir,
          profile: args.profile,
        });
        const handle = await context.writeResource("projectState", dir, {
          projectDir: dir,
          id: parsed.id,
          title: args.title,
          profile: args.profile,
          state: PHASES[0],
          skipped: [],
          history: [{ from: "-", to: PHASES[0], via: "start", at }],
          createdAt: at,
          updatedAt: at,
        });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report one project's lifecycle status: current phase gate evaluated against artifacts actually on disk, present commands, and the suggested next action (command, template file, target ARC filename, mandatory inputs). The skill's main dispatch point.",
      arguments: z.object({
        project: z.string().describe("Project dir, e.g. 001-payments"),
      }),
      execute: async (args, context) => {
        const root = context.globalArgs.path;
        const state = await readProjectState(context, args.project);
        if (!state) {
          throw new Error(
            `No state for project ${args.project} — run startProject first`,
          );
        }
        const have = await presentCommands(root, args.project);
        const terminal = state.state === "complete" ||
          state.state === "abandoned";
        const gate = terminal
          ? { satisfied: true, groups: [] }
          : evaluateGate(have, state.state, state.profile);
        const phaseIndex = PHASES.indexOf(
          state.state as (typeof PHASES)[number],
        );
        const handle = await context.writeResource(
          "projectStatus",
          `${args.project}-status`,
          {
            projectDir: state.projectDir,
            id: state.id,
            title: state.title,
            profile: state.profile,
            state: state.state,
            phaseIndex: phaseIndex === -1 ? PHASES.length : phaseIndex,
            phaseCount: PHASES.length,
            gate: gate.groups,
            gateSatisfied: gate.satisfied,
            skippable: PHASE_GATES[state.state]?.skippable ?? false,
            presentCommands: [...have].sort(),
            artifactCount: have.size,
            nextAction: terminal
              ? undefined
              : suggestNextAction(gate.groups, state.id),
            skipped: state.skipped,
            statusAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    advance: {
      description:
        "Advance a project to the next phase — gated: rescans the disk and refuses unless every gate group of the current phase has an artifact present. From the last phase (story) advances to complete.",
      arguments: z.object({
        project: z.string().describe("Project dir, e.g. 001-payments"),
        note: z.string().optional().describe(
          "Optional note recorded in the transition history",
        ),
      }),
      execute: async (args, context) => {
        const root = context.globalArgs.path;
        const state = await readProjectState(context, args.project);
        if (!state) {
          throw new Error(
            `No state for project ${args.project} — run startProject first`,
          );
        }
        if (state.state === "complete" || state.state === "abandoned") {
          throw new Error(`Project ${args.project} is ${state.state}`);
        }
        const have = await presentCommands(root, args.project);
        const gate = evaluateGate(have, state.state, state.profile);
        if (!gate.satisfied) {
          const missing = gate.groups
            .filter((g) => !g.satisfied)
            .map((g) => g.anyOf.join(" | "))
            .join("; ");
          throw new Error(
            `Gate for phase "${state.state}" not satisfied — produce one of each: ${missing}. ` +
              `(Or skipPhase with a reason${
                PHASE_GATES[state.state]?.skippable
                  ? ""
                  : " — note: this phase is NOT skippable"
              }.)`,
          );
        }
        const to = nextPhase(state.state);
        const at = new Date().toISOString();
        context.logger.info("Advancing {dir}: {from} -> {to}", {
          dir: args.project,
          from: state.state,
          to,
        });
        const handle = await context.writeResource(
          "projectState",
          args.project,
          {
            ...state,
            state: to,
            history: [...state.history, {
              from: state.state,
              to,
              via: "advance",
              at,
              note: args.note,
            }],
            updatedAt: at,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    skipPhase: {
      description:
        "Skip the project's current phase with an explicit recorded reason. Only phases marked skippable (business-case, procurement, design-review, delivery, operations, story) can be skipped.",
      arguments: z.object({
        project: z.string().describe("Project dir, e.g. 001-payments"),
        reason: z.string().describe("Why this phase does not apply"),
      }),
      execute: async (args, context) => {
        const state = await readProjectState(context, args.project);
        if (!state) {
          throw new Error(
            `No state for project ${args.project} — run startProject first`,
          );
        }
        if (state.state === "complete" || state.state === "abandoned") {
          throw new Error(`Project ${args.project} is ${state.state}`);
        }
        if (!PHASE_GATES[state.state]?.skippable) {
          throw new Error(
            `Phase "${state.state}" is not skippable — its artifacts are mandatory`,
          );
        }
        const to = nextPhase(state.state);
        const at = new Date().toISOString();
        context.logger.info("Skipping {phase} on {dir}: {reason}", {
          phase: state.state,
          dir: args.project,
          reason: args.reason,
        });
        const handle = await context.writeResource(
          "projectState",
          args.project,
          {
            ...state,
            state: to,
            skipped: [...state.skipped, {
              phase: state.state,
              reason: args.reason,
              at,
            }],
            history: [...state.history, {
              from: state.state,
              to,
              via: "skip",
              at,
              note: args.reason,
            }],
            updatedAt: at,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    abandon: {
      description:
        "Abandon a governance project from any state, recording the reason.",
      arguments: z.object({
        project: z.string().describe("Project dir, e.g. 001-payments"),
        reason: z.string().describe("Why the project is abandoned"),
      }),
      execute: async (args, context) => {
        const state = await readProjectState(context, args.project);
        if (!state) {
          throw new Error(`No state for project ${args.project}`);
        }
        const at = new Date().toISOString();
        const handle = await context.writeResource(
          "projectState",
          args.project,
          {
            ...state,
            state: "abandoned",
            abandonReason: args.reason,
            history: [...state.history, {
              from: state.state,
              to: "abandoned",
              via: "abandon",
              at,
              note: args.reason,
            }],
            updatedAt: at,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    templates: {
      description:
        "Catalog the bundled arc-kit templates: producing command, ARC doc code, template file, and size.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const templates: Array<{
          command: string;
          docCode?: string;
          file: string;
          sizeBytes: number;
        }> = [];
        for (const [command, file] of Object.entries(TEMPLATE_MAP).sort()) {
          let sizeBytes = 0;
          try {
            const stat = await Deno.stat(
              context.extensionFile(`${TEMPLATES_DIR}/${file}`),
            );
            sizeBytes = stat.size;
          } catch {
            // bundled file missing — surface as zero size
          }
          templates.push({
            command,
            docCode: COMMAND_TO_CODE[command],
            file,
            sizeBytes,
          });
        }
        const partials: string[] = [];
        try {
          for await (
            const e of Deno.readDir(
              context.extensionFile(`${TEMPLATES_DIR}/_partials`),
            )
          ) {
            if (e.isFile) partials.push(e.name);
          }
        } catch {
          // no partials bundled
        }
        // LB6: reconcile against provisionTemplates(), which copies EVERY
        // bundled file — walk the same source dir and surface any bundled
        // file with no TEMPLATE_MAP command (dotfiles and _partials/ are
        // not "orphan commands", so they're excluded here).
        const mapped = new Set(Object.values(TEMPLATE_MAP));
        const unmappedFiles: string[] = [];
        try {
          for await (
            const e of Deno.readDir(context.extensionFile(TEMPLATES_DIR))
          ) {
            if (!e.isFile) continue;
            if (e.name.startsWith(".")) continue;
            if (!mapped.has(e.name)) unmappedFiles.push(e.name);
          }
        } catch {
          // bundled templates dir missing entirely — nothing to reconcile
        }
        const handle = await context.writeResource(
          "templateCatalog",
          "templates",
          {
            templateCount: templates.length,
            templates,
            partials: partials.sort(),
            unmappedFiles: unmappedFiles.sort(),
            listedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    template: {
      description:
        "Serve one bundled template by command name (e.g. requirements, risk, adr, wardley.doctrine), with its ARC doc code, suggested target filename (when a project is given), and mandatory input artifacts to read first.",
      arguments: z.object({
        command: z.string().describe(
          "ArcKit command whose template to fetch, e.g. requirements",
        ),
        project: z.string().optional().describe(
          "Project dir (e.g. 001-payments) — fills in targetDir and suggested ARC filename",
        ),
      }),
      execute: async (args, context) => {
        const file = TEMPLATE_MAP[args.command];
        if (!file) {
          throw new Error(
            `No template for command "${args.command}". Available: ${
              Object.keys(TEMPLATE_MAP).sort().join(", ")
            }`,
          );
        }
        const cap = context.globalArgs.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
        const templatePath = context.extensionFile(`${TEMPLATES_DIR}/${file}`);
        const st = await Deno.stat(templatePath);
        if (st.size > cap) {
          throw new Error(
            `Template file "${file}" (${st.size} bytes) exceeds max size ${cap} bytes`,
          );
        }
        const content = await Deno.readTextFile(templatePath);
        const docCode = COMMAND_TO_CODE[args.command];
        const projectId = args.project
          ? parseProjectDir(args.project)?.id
          : undefined;
        const handle = await context.writeResource(
          "templateDoc",
          `template-${args.command.replace(/\./g, "-")}`,
          {
            command: args.command,
            docCode,
            templateFile: file,
            targetDir: args.project ? `projects/${args.project}` : undefined,
            suggestedFilename: docCode && projectId
              ? `ARC-${projectId}-${docCode}-v1.0.md`
              : undefined,
            mandatoryInputs: MANDATORY_DEPS[args.command] ?? [],
            content,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    provisionTemplates: {
      description:
        "Copy every bundled arc-kit template (including _partials) into the workspace's .arckit/templates/ directory, refreshing defaults. Customizations belong in .arckit/templates-custom/, which is never touched.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const root = context.globalArgs.path;
        const targetDir = `${root}/.arckit/templates`;
        await Deno.mkdir(`${targetDir}/_partials`, { recursive: true });
        const written: string[] = [];
        const srcDir = context.extensionFile(TEMPLATES_DIR);
        for await (const e of Deno.readDir(srcDir)) {
          if (e.isFile) {
            await Deno.copyFile(
              `${srcDir}/${e.name}`,
              `${targetDir}/${e.name}`,
            );
            written.push(e.name);
          }
        }
        try {
          for await (const e of Deno.readDir(`${srcDir}/_partials`)) {
            if (!e.isFile) continue;
            await Deno.copyFile(
              `${srcDir}/_partials/${e.name}`,
              `${targetDir}/_partials/${e.name}`,
            );
            written.push(`_partials/${e.name}`);
          }
        } catch {
          // no partials bundled
        }
        const handle = await context.writeResource(
          "provisionResult",
          "provision",
          {
            path: root,
            targetDir: ".arckit/templates",
            written: written.sort(),
            fileCount: written.length,
            provisionedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    migrateClassification: {
      description:
        "Port of `arckit migrate-classification`: walk every ARC-* markdown artifact and map Document Control Classification values from the UK ladder to the target classification ladder — uae (default, UAE Smart Data: PUBLIC→Open, OFFICIAL→Shared, OFFICIAL-SENSITIVE→Confidential) or nl (NL rubricering/VIRBI 2025: PUBLIC→Ongerubriceerd, SECRET→Stg. GEHEIM, TOP SECRET→Stg. ZEER GEHEIM — SECRET/TOP SECRET sourced from the German BMI's NATO-equivalence table, PUBLIC reasoned floor-to-floor; OFFICIAL and OFFICIAL-SENSITIVE have no published post-2014 UK→NL equivalence and are left byte-unchanged, recorded in `skipped` with a reason naming the value for a human to decide by hand). Never aborts on an undecidable value — one such document is skipped, not the whole run. Report-only by default; pass apply=true to write.",
      arguments: z.object({
        apply: z.boolean().default(false).describe(
          "Write the proposed changes (default: report only)",
        ),
        ladder: z.enum(CLASSIFICATION_LADDER_NAMES).default("uae").describe(
          "Target classification ladder — uae (UAE Smart Data, default) or nl (NL rubricering, VIRBI 2025)",
        ),
      }),
      execute: async (args, context) => {
        const root = context.globalArgs.path;
        // Defensive `??`: a fake test context can bypass the zod default.
        const cap = context.globalArgs.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
        const snapshot = await scanWorkspace(root);
        const files: Array<{
          relPath: string;
          changes: Array<{ from: string; to: string }>;
        }> = [];
        const skipped: Array<{ relPath: string; reason: string }> = [];
        let scannedFiles = 0;
        let totalChanges = 0;
        for (const p of snapshot.projects) {
          for (const a of p.artifacts) {
            if (a.format !== "md") continue;
            scannedFiles++;
            const relPath = `${p.dir}/${a.relPath}`;
            const full = `${root}/projects/${relPath}`;
            // LB3: cap-check via the scan snapshot's sizeBytes, WITHOUT
            // reading the file — applies in both report and apply modes.
            if (a.sizeBytes > cap) {
              skipped.push({ relPath, reason: "oversize" });
              continue;
            }
            const text = await Deno.readTextFile(full);
            const { newText, changes, requiresDecision } =
              proposeClassification(text, args.ladder);
            // A value with no defensible ladder target (today: OFFICIAL /
            // OFFICIAL-SENSITIVE under ladder="nl") is surfaced, never
            // guessed — and never aborts the run. A file can carry BOTH
            // requiresDecision entries and real changes; both are handled,
            // neither suppresses the other.
            for (const rd of requiresDecision) {
              skipped.push({
                relPath,
                reason:
                  `requires explicit rubricering decision: no published UK→NL equivalence for ${rd.value} (UK abolished CONFIDENTIAL/RESTRICTED in 2014); set the rubricering by hand`,
              });
            }
            const real = changes.filter((c) => c.from !== c.to);
            if (!real.length) continue;
            if (args.apply) {
              // LB7: never write THROUGH a symlink — that could clobber a
              // target outside the workspace, undercutting LB1 confinement.
              // Report-only mode may still read through it and propose.
              const li = await Deno.lstat(full);
              if (li.isSymlink) {
                skipped.push({ relPath, reason: "symlink" });
                continue;
              }
              // LB2: never clobber in place. Best-effort recovery backup of
              // the pre-migration content, then write-temp + atomic rename
              // so a reader always sees the whole old or whole new file,
              // never a truncated partial; a crash mid-write leaves `full`
              // intact plus a recoverable `.tmp` orphan.
              await Deno.copyFile(full, `${full}.bak`);
              const tmp = `${full}.${crypto.randomUUID()}.tmp`;
              await Deno.writeTextFile(tmp, newText);
              await Deno.rename(tmp, full);
            }
            files.push({ relPath, changes: real });
            totalChanges += real.length;
          }
        }
        context.logger.info(
          "Classification migration ({ladder}): {n} changes in {f} files, {s} skipped (apply={apply})",
          {
            ladder: args.ladder,
            n: totalChanges,
            f: files.length,
            s: skipped.length,
            apply: args.apply,
          },
        );
        const handle = await context.writeResource(
          "classificationMigration",
          "classification-migration",
          {
            path: root,
            apply: args.apply,
            ladder: args.ladder,
            scannedFiles,
            files,
            totalChanges,
            skipped,
            ranAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    euSovereigntyScore: {
      description:
        "EU Cloud Sovereignty Framework v1.2.1: score a subject (service or provider) against the eight weighted Sovereignty Objectives (SOV-1..SOV-8), report overallSeal (the framework's actual rejection gate — the minimum SEAL across all eight objectives) and, when caller-supplied SEAL floors are given, pass/fail per objective. Computes an assessment — it does not certify.",
      arguments: z.object({
        subject: z.string().describe(
          "The service or provider being assessed",
        ),
        project: z.string().optional().describe(
          "Project dir, e.g. 001-payments — prefixes the written resource name",
        ),
        objectives: z.array(z.object({
          id: z.string().describe(
            "Sovereignty Objective id — SOV-1..SOV-8 (EU Cloud Sovereignty Framework v1.2.1), any order",
          ),
          score: z.number().describe("Achieved score for this objective"),
          maxScore: z.number().optional().describe(
            "Maximum possible score for this objective — defaults per-objective to SOV_MAX_SCORES[id] (the EU CSF v1.2.1 calculator's actual achievable ceiling, e.g. 1002 for SOV-2) when omitted. The contribution divisor is a separate concern: it stays the calculator's flat nominal 1000 unless this is supplied explicitly, so a maximal response with maxScore omitted throughout can score just over 100% (100.0756%) — faithful to the calculator, not capped",
          ),
          seal: z.string().optional().describe(
            "Achieved SEAL level for this objective (SEAL0..SEAL4), if assessed",
          ),
          evidence: z.string().optional().describe(
            "Evidence/basis recorded for this objective's score — e.g. who holds decisive authority over the service, which legal system governs the contract, cryptographic access, support-staff jurisdiction, hardware/firmware/software provenance, API/licence exit rights",
          ),
        })).describe(
          "Exactly the eight EU CSF v1.2.1 Sovereignty Objectives SOV-1..SOV-8, any order",
        ),
        sealFloors: z.record(z.string(), z.string()).optional().describe(
          "Caller-supplied minimum SEAL per objective id — never hardcoded; the tender specification defines these, per the EU CSF",
        ),
      }),
      execute: async (args, context) => {
        const result = computeSovereigntyScore({
          objectives: args.objectives,
          sealFloors: args.sealFloors,
        });
        const slug = slugify(args.subject);
        const name = args.project
          ? `${args.project}-sovereignty-${slug}`
          : `sovereignty-${slug}`;
        context.logger.info(
          "Sovereignty score for {subject}: {score}",
          { subject: args.subject, score: result.score },
        );
        const handle = await context.writeResource(
          "sovereigntyAssessment",
          name,
          {
            subject: args.subject,
            project: args.project,
            ...result,
            assessedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    nlCloudEligibility: {
      description:
        "Herziening rijksbreed cloudbeleid 2026: evaluate whether a subject's public-cloud use is allowed | conditional | discouraged | prohibited, from rubricering/TBB classification, processing region, supplier jurisdiction, and the entity/clause-4.5/clause-4.3 governance facts. Every governance input is required (fail-closed); rubricering and tbbCategory are validated against the NL rubricering and TBB enums at the argument boundary.",
      arguments: z.object({
        subject: z.string().describe(
          "The service or provider being assessed",
        ),
        project: z.string().optional().describe(
          "Project dir, e.g. 001-payments — prefixes the written resource name",
        ),
        rubricering: z.enum(RUBRICERING_VALUES).optional().describe(
          "NL VIRBI 2025 rubricering level (at least one of rubricering/tbbCategory required; Stg. = staatsgeheim)",
        ),
        tbbCategory: z.enum(TBB_VALUES).optional().describe(
          "Te Beschermen Belang category, TBB 1 (highest) .. TBB 4 (lowest) — TBB systematiek, Gereedschap v1.0",
        ),
        processingRegion: z.string().describe(
          "Where the data is stored and processed (e.g. EEA, Switzerland, United States)",
        ),
        supplierJurisdiction: z.string().describe(
          "Jurisdiction(s) the supplier and its sub-processors fall under — distinct from processingRegion",
        ),
        isPrimaryProcess: z.boolean().describe(
          "Whether the service supports the entity's primary process",
        ),
        isBasisregistratie: z.boolean().describe(
          "Whether the service holds basisregistratie source data",
        ),
        isEmailOrWorkplace: z.boolean().describe(
          "Whether the service is email/workplace storage (clause 4.5)",
        ),
        continuityEstablishedIndependently: z.boolean().describe(
          "Clause 4.5 condition: continuity established independently of the supplier",
        ),
        riskAnalysisAndExitPlanTested: z.boolean().describe(
          "Clause 4.5 condition: risk analysis and exit plan tested",
        ),
        ministerialApprovalObtained: z.boolean().describe(
          "Clause 4.5 condition: ministerial approval obtained",
        ),
        isVitaleAanbieder: z.boolean().describe(
          "Whether the entity is a vitale aanbieder",
        ),
        isWwkeEntity: z.boolean().describe(
          "Whether the entity is a Wwke (Cyberbeveiligingswet) entity",
        ),
        isCbwEssentialEntity: z.boolean().describe(
          "Whether the entity is a Cbw (NIS2) essential entity",
        ),
      }),
      execute: async (args, context) => {
        const result = evaluateCloudEligibility({
          rubricering: args.rubricering,
          tbbCategory: args.tbbCategory,
          processingRegion: args.processingRegion,
          supplierJurisdiction: args.supplierJurisdiction,
          isPrimaryProcess: args.isPrimaryProcess,
          isBasisregistratie: args.isBasisregistratie,
          isEmailOrWorkplace: args.isEmailOrWorkplace,
          continuityEstablishedIndependently:
            args.continuityEstablishedIndependently,
          riskAnalysisAndExitPlanTested: args.riskAnalysisAndExitPlanTested,
          ministerialApprovalObtained: args.ministerialApprovalObtained,
          isVitaleAanbieder: args.isVitaleAanbieder,
          isWwkeEntity: args.isWwkeEntity,
          isCbwEssentialEntity: args.isCbwEssentialEntity,
        });
        const slug = slugify(args.subject);
        const name = args.project
          ? `${args.project}-cloud-eligibility-${slug}`
          : `cloud-eligibility-${slug}`;
        context.logger.info(
          "Cloud eligibility for {subject}: {verdict}",
          { subject: args.subject, verdict: result.verdict },
        );
        const handle = await context.writeResource(
          "cloudEligibility",
          name,
          {
            subject: args.subject,
            project: args.project,
            ...result,
            evaluatedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
