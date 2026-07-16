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

const GlobalArgsSchema = z.object({
  path: z.string().describe(
    "Absolute path to the ArcKit workspace root (the directory containing projects/)",
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
};

/** command → ARC document type code (inverse of DOC_CODES). */
export const COMMAND_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(DOC_CODES).map(([code, command]) => [command, code]),
);

// ---------- Governance state machine (phases from the DSM tier structure) ----

export const PROFILES = ["standard", "uk-gov", "mod", "ai"] as const;

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
  state: z.string(),
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

const MigrationSchema = z.object({
  path: z.string(),
  apply: z.boolean(),
  scannedFiles: z.number(),
  files: z.array(z.object({
    relPath: z.string(),
    changes: z.array(z.object({ from: z.string(), to: z.string() })),
  })),
  totalChanges: z.number(),
  ranAt: z.string(),
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
  const m = dirname.match(/^(\d{3})-(.+)$/);
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
 * `| **Classification** | <UK value> |` lines to the UAE Smart Data ladder.
 */
export function proposeClassification(
  text: string,
): { newText: string; changes: Array<{ from: string; to: string }> } {
  const changes: Array<{ from: string; to: string }> = [];
  const newText = text.replace(
    CLASSIFICATION_LINE,
    (_m, pre, value, post) => {
      const mapped = CLASSIFICATION_MAPPING[value] ?? value;
      changes.push({ from: value, to: mapped });
      return `${pre}${mapped}${post}`;
    },
  );
  return { newText, changes };
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
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || depth >= 6) continue;
      out.push(
        ...await listFilesRecursive(`${dir}/${entry.name}`, relPath, depth + 1),
      );
    } else if (entry.isFile) {
      out.push(relPath);
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
    if (!entry.isDirectory) continue;
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
async function readProjectState(context, projectDir: string) {
  const raw = await context.readResource!(projectDir);
  if (!raw) return null;
  return ProjectStateSchema.parse(raw);
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
  version: "2026.07.16.2",
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
        "Report (or applied result) of the UK→UAE Smart Data classification ladder migration across all ARC-* artifacts.",
      schema: MigrationSchema,
      lifetime: "infinite",
      garbageCollection: 5,
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
        const handle = await context.writeResource(
          "templateCatalog",
          "templates",
          {
            templateCount: templates.length,
            templates,
            partials: partials.sort(),
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
        const content = await Deno.readTextFile(
          context.extensionFile(`${TEMPLATES_DIR}/${file}`),
        );
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
        "Port of `arckit migrate-classification`: walk every ARC-* markdown artifact and map Document Control Classification values from the UK ladder to the UAE Smart Data ladder (PUBLIC→Open, OFFICIAL→Shared, OFFICIAL-SENSITIVE→Confidential). Report-only by default; pass apply=true to write.",
      arguments: z.object({
        apply: z.boolean().default(false).describe(
          "Write the proposed changes (default: report only)",
        ),
      }),
      execute: async (args, context) => {
        const root = context.globalArgs.path;
        const snapshot = await scanWorkspace(root);
        const files: Array<{
          relPath: string;
          changes: Array<{ from: string; to: string }>;
        }> = [];
        let scannedFiles = 0;
        let totalChanges = 0;
        for (const p of snapshot.projects) {
          for (const a of p.artifacts) {
            if (a.format !== "md") continue;
            scannedFiles++;
            const full = `${root}/projects/${p.dir}/${a.relPath}`;
            const text = await Deno.readTextFile(full);
            const { newText, changes } = proposeClassification(text);
            if (!changes.length) continue;
            const real = changes.filter((c) => c.from !== c.to);
            if (!real.length) continue;
            if (args.apply) await Deno.writeTextFile(full, newText);
            files.push({ relPath: `${p.dir}/${a.relPath}`, changes: real });
            totalChanges += real.length;
          }
        }
        context.logger.info(
          "Classification migration: {n} changes in {f} files (apply={apply})",
          { n: totalChanges, f: files.length, apply: args.apply },
        );
        const handle = await context.writeResource(
          "classificationMigration",
          "classification-migration",
          {
            path: root,
            apply: args.apply,
            scannedFiles,
            files,
            totalChanges,
            ranAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
