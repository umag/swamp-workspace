/**
 * NL/EU sovereign-cloud overlay suite for `@magistr/arckit/workspace`
 * (arckit-nl-sovereign-cloud). TDD RED round: every symbol imported below
 * that does not yet exist on `arckit_workspace.ts` (computeSovereigntyScore,
 * evaluateCloudEligibility, CLASSIFICATION_LADDERS, SEAL_LABELS) makes this
 * whole file fail to load — that is the expected and correct state for this
 * round. No implementation code is written here.
 *
 * SCOPE: this file tests the two new PURE functions, the new reference
 * tables (doc codes, template map, profile extras, mandatory deps), AND the
 * two new swamp METHODS that wrap the pure functions (`euSovereigntyScore`,
 * `nlCloudEligibility`) per test review round 1's HIGH finding — resource
 * naming (`sovereignty-${slug}` / `cloud-eligibility-${slug}`, `${project}-`
 * prefixed when a project is given, mirroring `projectStatus`'s
 * `${project}-status`), the subject slug coming from the file's existing
 * exported `slugify()`, logger.info carrying the computed score/verdict, and
 * the zod argument-schema gate (required-field + enum rejection) proven via
 * `run()`, never `execute()` directly.
 *
 * ASSUMED CONTRACTS (this suite is TDD-first — these shapes ARE the spec the
 * implementation must satisfy, chosen to be the smallest reasonable design
 * consistent with the plan's dddAnalysis/testStrategy):
 *
 *   CLASSIFICATION_LADDERS: Record<"uae" | "nl" | string, Record<string, string>>
 *     — one target table per ladder, keyed by a SUBSET of the fixed UK
 *     source vocabulary (PUBLIC | OFFICIAL | OFFICIAL-SENSITIVE | SECRET |
 *     TOP SECRET) in every ladder. CLASSIFICATION_LADDERS.uae covers all
 *     five and is structurally identical to the existing
 *     CLASSIFICATION_MAPPING. CLASSIFICATION_LADDERS.nl is DELIBERATELY
 *     NARROW — only PUBLIC/SECRET/TOP SECRET — per a sourcing review: OFFICIAL
 *     and OFFICIAL-SENSITIVE have no published post-2014 UK->NL rubricering
 *     equivalence (see NL_REQUIRES_EXPLICIT_DECISION) and are never guessed.
 *
 *   NL_REQUIRES_EXPLICIT_DECISION: readonly string[] — UK values with no
 *     nl-ladder target (today: OFFICIAL, OFFICIAL-SENSITIVE).
 *
 *   proposeClassification(text: string, ladder?: string):
 *     {
 *       newText: string;
 *       changes: Array<{ from: string; to: string }>;
 *       requiresDecision: Array<{ value: string }>;
 *     }
 *     — ladder defaults to "uae"; an unregistered ladder name throws. A
 *     source value present in NL_REQUIRES_EXPLICIT_DECISION but absent from
 *     the selected ladder's table is left byte-unchanged in `newText`,
 *     contributes no `changes` entry, and is named in `requiresDecision`
 *     instead. Under ladder="uae" every source value has a target, so
 *     `requiresDecision` is always [].
 *
 *   computeSovereigntyScore(input: {
 *     objectives: Array<{ id: string; score: number; maxScore: number; seal?: string; evidence?: string }>;
 *     sealFloors?: Record<string, string>;   // objective id -> minimum SEAL token
 *   }): {
 *     score: number;                          // 0..100, rounded to 2dp
 *     breakdown: Array<{ id: string; weight: number; contribution: number }>;
 *     floorsEvaluated: boolean;                // true iff sealFloors supplied
 *     floorsPassed: boolean;
 *     objectivesBelowFloor: string[];
 *   }
 *     — `objectives` must be exactly SOV-1..SOV-8 (any order). Throws on a
 *     missing objective, a negative score, score > maxScore, or maxScore<=0.
 *
 *   evaluateCloudEligibility(input: {
 *     rubricering?: string; tbbCategory?: string;   // at least one required
 *     processingRegion: string; supplierJurisdiction: string;
 *     isPrimaryProcess: boolean; isBasisregistratie: boolean;
 *     isEmailOrWorkplace: boolean;
 *     continuityEstablishedIndependently: boolean;
 *     riskAnalysisAndExitPlanTested: boolean;
 *     ministerialApprovalObtained: boolean;
 *     isVitaleAanbieder: boolean; isWwkeEntity: boolean; isCbwEssentialEntity: boolean;
 *   }): {
 *     verdict: "allowed" | "conditional" | "discouraged" | "prohibited";
 *     clauses: string[];
 *     reason: string;
 *     clause45?: {
 *       continuityEstablishedIndependently: boolean;
 *       riskAnalysisAndExitPlanTested: boolean;
 *       ministerialApprovalObtained: boolean;
 *       allMet: boolean;
 *     };
 *   }
 *     — throws (fail-closed) when neither rubricering nor tbbCategory is
 *     given, when any required key is entirely omitted, or when
 *     rubricering/tbbCategory holds an unrecognized value. `clause45` is
 *     populated whenever isEmailOrWorkplace is true, omitted otherwise.
 *     rubricering vocabulary used by these tests: Ongerubriceerd |
 *     Dep. VERTROUWELIJK | Stg. CONFIDENTIEEL | Stg. GEHEIM |
 *     Stg. ZEER GEHEIM (the NL rubricering ladder — "Stg." = staatsgeheim).
 *     tbbCategory vocabulary: "TBB 1".."TBB 4". processingRegion /
 *     supplierJurisdiction are free-form strings in this suite ("EEA",
 *     "Switzerland", "Caribisch Nederland", "United States", "EU").
 *
 *   SEAL_LABELS: Record<"SEAL0".."SEAL4", { en: string; nl: string }>
 *     — exhaustive lookup table (dddAnalysis: "English and Dutch labels ...
 *     live in an exported lookup table"); the Dutch renderings are pinned
 *     verbatim from the NDS Cloudprogramma notitie cited in the plan.
 *
 *   model.methods.euSovereigntyScore — args `{ subject: string; project?:
 *     string } & ComputeSovereigntyScoreInput` (subject is the service or
 *     provider assessed, mirroring `template`'s existing `project?`
 *     pattern). Writes resource spec "sovereigntyAssessment" (per
 *     dddAnalysis's RESOURCES paragraph) with data name
 *     `sovereignty-${slugify(subject)}`, or `${project}-sovereignty-${slugify(subject)}`
 *     when project is given (mirrors `projectStatus`'s `${project}-status`).
 *     Logs a one-line summary via context.logger.info carrying the computed
 *     score. Payload is the pure function's result plus per-objective
 *     evidence carried through — computes an assessment, does not certify,
 *     so the payload has no attestation/certified field.
 *
 *   model.methods.nlCloudEligibility — args `{ subject: string; project?:
 *     string } & CloudEligibilityInput`, with rubricering/tbbCategory as
 *     zod enums (so an unrecognized value is rejected AT THE ARGUMENT
 *     SCHEMA, before execute() runs — matching startProject's existing
 *     `profile: z.enum(PROFILES)` convention). Writes resource spec
 *     "cloudEligibility" with data name `cloud-eligibility-${slugify(subject)}`,
 *     or `${project}-cloud-eligibility-${slugify(subject)}` when project is
 *     given. Logs a one-line summary via context.logger.info carrying the
 *     computed verdict.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  CLASSIFICATION_LADDERS,
  CLASSIFICATION_MAPPING,
  COMMAND_TO_CODE,
  computeSovereigntyScore,
  DOC_CODES,
  evaluateCloudEligibility,
  gateFor,
  MANDATORY_DEPS,
  model,
  NL_REQUIRES_EXPLICIT_DECISION,
  parseArtifactFilename,
  PHASES,
  PROFILE_EXTRAS,
  PROFILES,
  proposeClassification,
  SEAL_LABELS,
  slugify,
  TEMPLATE_MAP,
} from "./arckit_workspace.ts";
import {
  arcFilename,
  docControlContent,
  makeCtx,
  run,
  withTempWorkspace,
  writeArtifact,
} from "./fixtures/workspace.ts";

// =============================================================================
// 3. CLASSIFICATION_LADDERS registry + proposeClassification(text, ladder?)
// =============================================================================

// proposeClassification's real (current) signature takes exactly one
// argument; the optional `ladder` parameter is the very thing this round's
// tests are driving into existence. Routing every ladder-arg call through
// this cast means the file's TS errors stay confined to the "not exported"
// category (CLASSIFICATION_LADDERS / computeSovereigntyScore /
// evaluateCloudEligibility / SEAL_LABELS below) rather than also raising a
// TS2554 "expected 1 argument" error here — once the real signature grows
// the optional second parameter, this cast becomes a no-op and every
// assertion below starts doing real work.
type ProposeClassificationWithLadder = (
  text: string,
  ladder?: string,
) => {
  newText: string;
  changes: Array<{ from: string; to: string }>;
  requiresDecision: Array<{ value: string }>;
};

const proposeWithLadder =
  proposeClassification as unknown as ProposeClassificationWithLadder;

Deno.test("CLASSIFICATION_LADDERS registers exactly the uae and nl ladders", () => {
  assertEquals(Object.keys(CLASSIFICATION_LADDERS).sort(), ["nl", "uae"]);
});

Deno.test("CLASSIFICATION_LADDERS.uae is structurally identical to today's CLASSIFICATION_MAPPING — the registry generalizes the existing table, it does not replace it", () => {
  assertEquals(CLASSIFICATION_LADDERS.uae, CLASSIFICATION_MAPPING);
});

Deno.test("CLASSIFICATION_LADDERS.nl maps only the sourced/reasoned UK levels to their NL rubricering target — narrowed per sourcing review (OFFICIAL/OFFICIAL-SENSITIVE have no published post-2014 equivalence and are absent)", () => {
  assertEquals(CLASSIFICATION_LADDERS.nl, {
    "PUBLIC": "Ongerubriceerd",
    "SECRET": "Stg. GEHEIM",
    "TOP SECRET": "Stg. ZEER GEHEIM",
  });
});

Deno.test("NL_REQUIRES_EXPLICIT_DECISION names exactly OFFICIAL and OFFICIAL-SENSITIVE — the UK values absent from CLASSIFICATION_LADDERS.nl with no published post-2014 equivalence", () => {
  assertEquals(
    [...NL_REQUIRES_EXPLICIT_DECISION].sort(),
    ["OFFICIAL", "OFFICIAL-SENSITIVE"],
  );
  for (const v of NL_REQUIRES_EXPLICIT_DECISION) {
    assert(
      !(v in CLASSIFICATION_LADDERS.nl),
      `${v} must be absent from CLASSIFICATION_LADDERS.nl`,
    );
  }
});

Deno.test("Stg. CONFIDENTIEEL is intentionally unmapped in the NL ladder — no UK source level targets it", () => {
  assert(
    !Object.values(CLASSIFICATION_LADDERS.nl).includes("Stg. CONFIDENTIEEL"),
  );
});

Deno.test("proposeClassification(text, 'nl') maps the three sourced/reasoned UK values (PUBLIC, SECRET, TOP SECRET) to their NL rubricering target, and leaves OFFICIAL/OFFICIAL-SENSITIVE byte-unchanged pending an explicit decision", () => {
  const doc = [
    "| **Classification** | PUBLIC |",
    "| **Classification** | OFFICIAL |",
    "| **Classification** | OFFICIAL-SENSITIVE |",
    "| **Classification** | SECRET |",
    "| **Classification** | TOP SECRET |",
  ].join("\n");
  const { newText, changes, requiresDecision } = proposeWithLadder(doc, "nl");
  assertEquals(changes, [
    { from: "PUBLIC", to: "Ongerubriceerd" },
    { from: "SECRET", to: "Stg. GEHEIM" },
    { from: "TOP SECRET", to: "Stg. ZEER GEHEIM" },
  ]);
  assertEquals(requiresDecision, [
    { value: "OFFICIAL" },
    { value: "OFFICIAL-SENSITIVE" },
  ]);
  assert(newText.includes("| **Classification** | Ongerubriceerd |"));
  assert(newText.includes("| **Classification** | Stg. GEHEIM |"));
  assert(newText.includes("| **Classification** | Stg. ZEER GEHEIM |"));
  // OFFICIAL / OFFICIAL-SENSITIVE lines are untouched, verbatim.
  assert(newText.includes("| **Classification** | OFFICIAL |"));
  assert(newText.includes("| **Classification** | OFFICIAL-SENSITIVE |"));
});

Deno.test("proposeClassification(text, 'nl'): OFFICIAL and OFFICIAL-SENSITIVE alone are left byte-unchanged, produce no changes entry, and are named in requiresDecision", () => {
  const doc = [
    "| **Classification** | OFFICIAL |",
    "| **Classification** | OFFICIAL-SENSITIVE |",
  ].join("\n");
  const { newText, changes, requiresDecision } = proposeWithLadder(doc, "nl");
  assertEquals(newText, doc);
  assertEquals(changes, []);
  assertEquals(requiresDecision, [
    { value: "OFFICIAL" },
    { value: "OFFICIAL-SENSITIVE" },
  ]);
});

Deno.test("proposeClassification(text, 'nl'): a mixed document rewrites SECRET AND reports OFFICIAL-SENSITIVE in the same pass — one does not suppress the other", () => {
  const doc = [
    "| **Classification** | SECRET |",
    "| **Classification** | OFFICIAL-SENSITIVE |",
  ].join("\n");
  const { newText, changes, requiresDecision } = proposeWithLadder(doc, "nl");
  assertEquals(changes, [{ from: "SECRET", to: "Stg. GEHEIM" }]);
  assertEquals(requiresDecision, [{ value: "OFFICIAL-SENSITIVE" }]);
  assert(newText.includes("| **Classification** | Stg. GEHEIM |"));
  assert(newText.includes("| **Classification** | OFFICIAL-SENSITIVE |"));
});

Deno.test("proposeClassification(text, 'uae'): requiresDecision is always empty — every UK source value has a uae target, so behavior is unchanged by the nl-ladder narrowing", () => {
  const doc = [
    "| **Classification** | PUBLIC |",
    "| **Classification** | OFFICIAL |",
    "| **Classification** | OFFICIAL-SENSITIVE |",
    "| **Classification** | SECRET |",
    "| **Classification** | TOP SECRET |",
  ].join("\n");
  const { changes, requiresDecision } = proposeWithLadder(doc, "uae");
  assertEquals(requiresDecision, []);
  assertEquals(changes.length, 5);
});

Deno.test("proposeClassification(text) with no ladder argument is identical to proposeClassification(text, 'uae') — uae is the default", () => {
  const doc = "| **Classification** | OFFICIAL-SENSITIVE |";
  assertEquals(proposeClassification(doc), proposeWithLadder(doc, "uae"));
});

Deno.test("second pass under ladder='nl' yields zero further changes", () => {
  const doc = "| **Classification** | SECRET |";
  const first = proposeWithLadder(doc, "nl");
  const second = proposeWithLadder(first.newText, "nl");
  assertEquals(second.changes, []);
  assertEquals(second.newText, first.newText);
});

Deno.test("second pass under ladder='nl' is idempotent for a document mixing sourced values (rewritten once) and undecidable values (never rewritten, still reported) — narrowed-ladder idempotence", () => {
  const doc = [
    "| **Classification** | PUBLIC |",
    "| **Classification** | OFFICIAL |",
    "| **Classification** | OFFICIAL-SENSITIVE |",
    "| **Classification** | SECRET |",
    "| **Classification** | TOP SECRET |",
  ].join("\n");
  const first = proposeWithLadder(doc, "nl");
  const second = proposeWithLadder(first.newText, "nl");
  assertEquals(second.changes, []);
  assertEquals(second.newText, first.newText);
  // The two undecidable values are still literally present (never
  // rewritten), so a second pass still reports them — the decision is still
  // pending, not silently dropped by a repeat run.
  assertEquals(
    second.requiresDecision.map((r) => r.value).sort(),
    ["OFFICIAL", "OFFICIAL-SENSITIVE"],
  );
});

Deno.test("cross-ladder: nl then uae over the same text — the second pass finds zero changes and no phantom entries (NL targets are not UK source tokens)", () => {
  const doc = "| **Classification** | SECRET |";
  const afterNl = proposeWithLadder(doc, "nl");
  const afterUae = proposeWithLadder(afterNl.newText, "uae");
  assertEquals(afterUae.changes, []);
  assertEquals(afterUae.newText, afterNl.newText);
});

Deno.test("cross-ladder: nl then uae over an nl-undecidable value — OFFICIAL is left unchanged by nl (still a valid UK token, not a phantom transform), so a subsequent uae pass legitimately maps it — this is NOT a phantom re-match, since nl never touched it", () => {
  const doc = "| **Classification** | OFFICIAL |";
  const afterNl = proposeWithLadder(doc, "nl");
  assertEquals(afterNl.changes, []);
  assertEquals(afterNl.requiresDecision, [{ value: "OFFICIAL" }]);
  assertEquals(afterNl.newText, doc);
  const afterUae = proposeWithLadder(afterNl.newText, "uae");
  assertEquals(afterUae.changes, [{ from: "OFFICIAL", to: "Shared" }]);
});

Deno.test("cross-ladder: uae then nl over the same text — the second pass finds zero changes and no phantom entries", () => {
  const doc = "| **Classification** | OFFICIAL |";
  const afterUae = proposeWithLadder(doc, "uae");
  const afterNl = proposeWithLadder(afterUae.newText, "nl");
  assertEquals(afterNl.changes, []);
  assertEquals(afterNl.newText, afterUae.newText);
});

Deno.test("proposeClassification rejects an unknown ladder name, listing the registered ladder names", () => {
  const err = assertThrows(() => proposeWithLadder("text", "bogus"), Error);
  assert(
    err.message.includes("uae") && err.message.includes("nl"),
    `error should list registered ladders, got: ${err.message}`,
  );
});

Deno.test("methods: migrateClassification records which ladder ran, defaulting to uae when omitted", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "REQ"),
      docControlContent("OFFICIAL"),
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", {}, ctx);
    assertEquals(written[0].payload.ladder, "uae");
  });
});

Deno.test("methods: migrateClassification({ ladder: 'nl' }) rewrites Document Control lines to the NL rubricering target and records ladder='nl'", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const full = await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "REQ"),
      docControlContent("SECRET"),
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(
      model,
      "migrateClassification",
      { apply: true, ladder: "nl" },
      ctx,
    );
    assertEquals(written[0].payload.ladder, "nl");
    const onDisk = await Deno.readTextFile(full);
    assert(onDisk.includes("| **Classification** | Stg. GEHEIM |"));
  });
});

Deno.test("methods: migrateClassification({ ladder: 'nl' }) over an OFFICIAL-SENSITIVE artifact SUCCEEDS without rewriting the file, and skipped carries the reason naming the value (one undecidable document must not abort the run)", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const full = await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "REQ"),
      docControlContent("OFFICIAL-SENSITIVE"),
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    // Must not throw — a single undecidable document is skipped, not fatal.
    await run(
      model,
      "migrateClassification",
      { apply: true, ladder: "nl" },
      ctx,
    );
    const payload = written[0].payload as Record<string, unknown>;
    const skipped = payload.skipped as Array<
      { relPath: string; reason: string }
    >;
    assert(
      skipped.some((s) => s.reason.includes("OFFICIAL-SENSITIVE")),
      `expected a skipped entry naming OFFICIAL-SENSITIVE, got: ${
        JSON.stringify(skipped)
      }`,
    );
    assertEquals(payload.totalChanges, 0);
    const onDisk = await Deno.readTextFile(full);
    assert(onDisk.includes("| **Classification** | OFFICIAL-SENSITIVE |"));
  });
});

Deno.test("methods: migrateClassification({ ladder: 'nl' }) over a document mixing SECRET and OFFICIAL-SENSITIVE rewrites SECRET AND records OFFICIAL-SENSITIVE in skipped — in the SAME run, neither suppresses the other", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const content = [
      "# Document",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| **Version** | 1.0 |",
      "| **Classification** | SECRET |",
      "",
      "## Second table",
      "",
      "| **Classification** | OFFICIAL-SENSITIVE |",
      "",
    ].join("\n");
    const full = await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "REQ"),
      content,
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(
      model,
      "migrateClassification",
      { apply: true, ladder: "nl" },
      ctx,
    );
    const payload = written[0].payload as Record<string, unknown>;
    const skipped = payload.skipped as Array<
      { relPath: string; reason: string }
    >;
    assert(skipped.some((s) => s.reason.includes("OFFICIAL-SENSITIVE")));
    assertEquals(payload.totalChanges, 1);
    const onDisk = await Deno.readTextFile(full);
    assert(onDisk.includes("| **Classification** | Stg. GEHEIM |"));
    assert(onDisk.includes("| **Classification** | OFFICIAL-SENSITIVE |"));
  });
});

// =============================================================================
// 5. New doc codes, templates, nl-gov profile, mandatory deps — table wiring
// =============================================================================

const NEW_CODES: Record<string, string> = {
  "NLTBB": "nl-tbb",
  "NLCLD": "nl-cloud",
  "EUSOV": "eu-sovereignty",
  "NLBIO": "nl-bio",
  "NLEXIT": "nl-exit",
  "NLDTIA": "nl-dtia",
};

const NEW_TEMPLATES: Record<string, string> = {
  "nl-tbb": "nl-tbb-classification-template.md",
  "nl-cloud": "nl-cloud-assessment-template.md",
  "eu-sovereignty": "eu-sovereignty-assessment-template.md",
  "nl-bio": "nl-bio-conformance-template.md",
  "nl-exit": "nl-exit-plan-template.md",
  "nl-dtia": "nl-dtia-template.md",
};

const NEW_MANDATORY_DEPS: Record<string, string[]> = {
  "nl-tbb": ["stakeholders"],
  "nl-cloud": ["requirements", "nl-tbb"],
  "eu-sovereignty": ["requirements"],
  "nl-bio": ["requirements", "principles"],
  "nl-exit": ["nl-cloud"],
  "nl-dtia": ["data-model", "requirements"],
};

Deno.test("DOC_CODES gains the six NL/EU sovereign-cloud codes, each resolving to its command", () => {
  for (const [code, command] of Object.entries(NEW_CODES)) {
    assertEquals(DOC_CODES[code], command, `DOC_CODES["${code}"]`);
  }
});

Deno.test("COMMAND_TO_CODE inverts the six new NL/EU doc codes", () => {
  for (const [code, command] of Object.entries(NEW_CODES)) {
    assertEquals(
      COMMAND_TO_CODE[command],
      code,
      `COMMAND_TO_CODE["${command}"]`,
    );
  }
});

Deno.test("TEMPLATE_MAP gains a bundled template file for each of the six new NL/EU commands", () => {
  for (const [command, file] of Object.entries(NEW_TEMPLATES)) {
    assertEquals(TEMPLATE_MAP[command], file, `TEMPLATE_MAP["${command}"]`);
  }
});

Deno.test("every one of the six new NL/EU template files exists in the bundled templates dir and is non-empty", async () => {
  const dir = new URL("../../templates/", import.meta.url).pathname;
  for (const file of Object.values(NEW_TEMPLATES)) {
    const stat = await Deno.stat(`${dir}${file}`);
    assert(stat.isFile && stat.size > 0, `${file} missing or empty`);
  }
});

Deno.test("PROFILES gains the nl-gov profile", () => {
  assert((PROFILES as readonly string[]).includes("nl-gov"));
});

Deno.test("nl-gov adds nl-tbb to the risk gate; standard's risk gate is untouched by it (the profile must not leak)", () => {
  assertEquals(gateFor("risk", "nl-gov"), [["risk"], ["nl-tbb"]]);
  assertEquals(gateFor("risk", "standard"), [["risk"]]);
});

Deno.test("nl-gov adds nl-cloud as an additional mandatory group on the design gate", () => {
  const standardGroups = gateFor("design", "standard");
  const nlGovGroups = gateFor("design", "nl-gov");
  assertEquals(nlGovGroups.length, standardGroups.length + 1);
  assertEquals(nlGovGroups.at(-1), ["nl-cloud"]);
  assertEquals(nlGovGroups[0], standardGroups[0]);
});

Deno.test("nl-gov adds nl-bio, nl-exit and eu-sovereignty as three SEPARATE mandatory groups on the assurance gate (order-insensitive)", () => {
  const groups = gateFor("assurance", "nl-gov");
  assertEquals(groups[0], ["analyze"]); // base assurance group, untouched
  assertEquals(groups.length, 4);
  const extras = groups.slice(1).map((g) => g.join(",")).sort();
  assertEquals(
    extras,
    [["eu-sovereignty"], ["nl-bio"], ["nl-exit"]].map((g) => g.join(","))
      .sort(),
  );
});

Deno.test("gateFor('assurance', 'standard') is unaffected by the nl-gov extras", () => {
  assertEquals(gateFor("assurance", "standard"), [["analyze"]]);
});

Deno.test("MANDATORY_DEPS gains the six NL/EU edges exactly as specified in the plan", () => {
  for (const [command, deps] of Object.entries(NEW_MANDATORY_DEPS)) {
    assertEquals(MANDATORY_DEPS[command], deps, `MANDATORY_DEPS["${command}"]`);
  }
});

Deno.test("nl-dtia is producible (doc code + template + mandatory deps) but gated NOWHERE — mandatory-input for other artifacts, never itself gate-required", () => {
  const profilesUnderTest = [...(PROFILES as readonly string[]), "nl-gov"];
  for (const profile of profilesUnderTest) {
    for (const phase of PHASES) {
      for (const group of gateFor(phase, profile)) {
        assert(
          !group.includes("nl-dtia"),
          `nl-dtia unexpectedly required by ${phase}/${profile}: ${group}`,
        );
      }
    }
  }
});

// ---------- table-driven phase-ordering (the core wiring correctness check) --

function phaseIndexFor(command: string, profile: string): number | undefined {
  for (let i = 0; i < PHASES.length; i++) {
    for (const group of gateFor(PHASES[i], profile)) {
      if (group.includes(command)) return i;
    }
  }
  return undefined;
}

Deno.test("table-driven: for EVERY MANDATORY_DEPS edge, the dependency's gating phase index is <= the dependent's, under every profile where both are gated (this is the check that would catch e.g. nl-tbb gating 'risk' while depending on something that only gates 'requirements')", () => {
  const profilesUnderTest = [...(PROFILES as readonly string[]), "nl-gov"];
  const exercised: string[] = [];
  for (const profile of profilesUnderTest) {
    for (const [command, deps] of Object.entries(MANDATORY_DEPS)) {
      const commandPhase = phaseIndexFor(command, profile);
      if (commandPhase === undefined) continue; // ungated under this profile
      for (const dep of deps) {
        const depPhase = phaseIndexFor(dep, profile);
        if (depPhase === undefined) continue; // ungated under this profile
        exercised.push(`${profile}:${dep}->${command}`);
        assert(
          depPhase <= commandPhase,
          `[${profile}] dependency "${dep}" gates phase "${
            PHASES[depPhase]
          }" (index ${depPhase}) AFTER dependent "${command}"'s phase "${
            PHASES[commandPhase]
          }" (index ${commandPhase})`,
        );
      }
    }
  }
  // Sanity: the nl-gov profile's own edges were actually exercised by this
  // sweep, not skipped as "ungated" — otherwise the assertion above is vacuous
  // for exactly the edge the plan calls out.
  assert(
    exercised.includes("nl-gov:stakeholders->nl-tbb"),
    `expected the nl-gov profile to exercise stakeholders->nl-tbb; exercised: ${
      exercised.join(", ")
    }`,
  );
});

Deno.test("every command referenced anywhere in PROFILE_EXTRAS (including nl-gov) has a TEMPLATE_MAP entry, a COMMAND_TO_CODE entry, and its bundled template file exists on disk", async () => {
  const dir = new URL("../../templates/", import.meta.url).pathname;
  const seen = new Set<string>();
  for (const perPhase of Object.values(PROFILE_EXTRAS)) {
    for (const groups of Object.values(perPhase)) {
      for (const group of groups) {
        for (const cmd of group) seen.add(cmd);
      }
    }
  }
  for (
    const nlCmd of ["nl-tbb", "nl-cloud", "nl-bio", "nl-exit", "eu-sovereignty"]
  ) {
    assert(seen.has(nlCmd), `${nlCmd} not found via the PROFILE_EXTRAS sweep`);
  }
  for (const cmd of seen) {
    assert(TEMPLATE_MAP[cmd], `no TEMPLATE_MAP entry for ${cmd}`);
    assert(COMMAND_TO_CODE[cmd], `no COMMAND_TO_CODE entry for ${cmd}`);
    const stat = await Deno.stat(`${dir}${TEMPLATE_MAP[cmd]}`);
    assert(
      stat.isFile && stat.size > 0,
      `${TEMPLATE_MAP[cmd]} missing or empty`,
    );
  }
});

// ---------- parseArtifactFilename round-trip for the six new codes -----------
// (Note: the EXISTING property-based round-trip test in
// arckit_workspace_property_test.ts already generalizes over
// `Object.keys(DOC_CODES)`, so it automatically exercises these six once
// they're added — no change needed there. These are explicit example-based
// pins for readability/debuggability.)

Deno.test("parseArtifactFilename round-trips all six new NL/EU doc codes", () => {
  for (const [code, command] of Object.entries(NEW_CODES)) {
    const a = parseArtifactFilename(`ARC-001-${code}-v1.0.md`);
    assert(a, `${code} failed to parse`);
    assertEquals(a.docType, code);
    assertEquals(a.command, command);
    assertEquals(a.instance, undefined);
  }
});

Deno.test("parseArtifactFilename resolves a multi-instance NLCLD artifact (ARC-001-NLCLD-2-v1.0.md) without colliding with any shorter existing code — longest-first resolution unaffected", () => {
  const a = parseArtifactFilename("ARC-001-NLCLD-2-v1.0.md");
  assert(a);
  assertEquals(a.docType, "NLCLD");
  assertEquals(a.command, "nl-cloud");
  assertEquals(a.instance, 2);
});

// =============================================================================
// 1. computeSovereigntyScore(input) — EU Cloud Sovereignty Framework v1.2.1
// =============================================================================

interface SovereigntyObjectiveInput {
  id: string;
  score: number;
  maxScore: number;
  seal?: string;
  evidence?: string;
}

interface SovereigntyScoreBreakdownEntry {
  id: string;
  weight: number;
  contribution: number;
}

interface SovereigntyScoreResult {
  score: number;
  breakdown: SovereigntyScoreBreakdownEntry[];
  floorsEvaluated: boolean;
  floorsPassed: boolean;
  objectivesBelowFloor: string[];
}

const SOV_IDS = [
  "SOV-1",
  "SOV-2",
  "SOV-3",
  "SOV-4",
  "SOV-5",
  "SOV-6",
  "SOV-7",
  "SOV-8",
] as const;

const SOV_WEIGHTS: Record<string, number> = {
  "SOV-1": 15,
  "SOV-2": 10,
  "SOV-3": 10,
  "SOV-4": 15,
  "SOV-5": 20,
  "SOV-6": 15,
  "SOV-7": 10,
  "SOV-8": 5,
};

function fullMarksObjectives(): SovereigntyObjectiveInput[] {
  return SOV_IDS.map((id) => ({ id, score: 10, maxScore: 10 }));
}

function zeroMarksObjectives(): SovereigntyObjectiveInput[] {
  return SOV_IDS.map((id) => ({ id, score: 0, maxScore: 10 }));
}

function withSeal(
  objectives: SovereigntyObjectiveInput[],
  seal: string,
): SovereigntyObjectiveInput[] {
  return objectives.map((o) => ({ ...o, seal }));
}

function asScore(x: unknown): SovereigntyScoreResult {
  return x as SovereigntyScoreResult;
}

Deno.test("sanity: the test fixture's SOV_WEIGHTS table sums to exactly 100 (EU CSF v1.2.1: 15/10/10/15/20/15/10/5)", () => {
  assertEquals(Object.values(SOV_WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

Deno.test("computeSovereigntyScore: full marks on every objective scores 100 (epsilon tolerance, never strict float equality)", () => {
  const r = asScore(
    computeSovereigntyScore({ objectives: fullMarksObjectives() }),
  );
  assertAlmostEquals(r.score, 100, 0.01);
});

Deno.test("computeSovereigntyScore: zero marks on every objective scores 0", () => {
  const r = asScore(
    computeSovereigntyScore({ objectives: zeroMarksObjectives() }),
  );
  assertAlmostEquals(r.score, 0, 0.01);
});

for (const targetId of SOV_IDS) {
  Deno.test(
    `computeSovereigntyScore: isolating ${targetId} at full marks (all others zero) pins its weight at ${
      SOV_WEIGHTS[targetId]
    }`,
    () => {
      const objectives = SOV_IDS.map((id) => ({
        id,
        score: id === targetId ? 10 : 0,
        maxScore: 10,
      }));
      const r = asScore(computeSovereigntyScore({ objectives }));
      assertAlmostEquals(r.score, SOV_WEIGHTS[targetId], 0.01);
    },
  );
}

Deno.test("computeSovereigntyScore: per-objective contribution equals round(score/maxScore * weight, 2) for a fractional case", () => {
  const objectives = SOV_IDS.map((id) => ({
    id,
    score: id === "SOV-1" ? 7 : 0,
    maxScore: id === "SOV-1" ? 9 : 10,
  }));
  const r = asScore(computeSovereigntyScore({ objectives }));
  const entry = r.breakdown.find((b) => b.id === "SOV-1");
  assert(entry, "breakdown missing SOV-1");
  assertAlmostEquals(entry!.weight, 15, 0.01);
  assertAlmostEquals(
    entry!.contribution,
    Math.round((7 / 9) * 15 * 100) / 100,
    0.01,
  );
});

Deno.test("computeSovereigntyScore rejects a missing objective (SOV-4 absent from the eight)", () => {
  const objectives = fullMarksObjectives().filter((o) => o.id !== "SOV-4");
  assertThrows(() => computeSovereigntyScore({ objectives }));
});

Deno.test("computeSovereigntyScore rejects a negative score", () => {
  const objectives = fullMarksObjectives().map((o) =>
    o.id === "SOV-1" ? { ...o, score: -1 } : o
  );
  assertThrows(() => computeSovereigntyScore({ objectives }));
});

Deno.test("computeSovereigntyScore rejects a score exceeding its maxScore", () => {
  const objectives = fullMarksObjectives().map((o) =>
    o.id === "SOV-2" ? { ...o, score: o.maxScore + 1 } : o
  );
  assertThrows(() => computeSovereigntyScore({ objectives }));
});

Deno.test("computeSovereigntyScore rejects maxScore <= 0", () => {
  const objectives = fullMarksObjectives().map((o) =>
    o.id === "SOV-3" ? { ...o, score: 0, maxScore: 0 } : o
  );
  assertThrows(() => computeSovereigntyScore({ objectives }));
});

Deno.test("computeSovereigntyScore: omitting sealFloors performs no floor check", () => {
  const r = asScore(
    computeSovereigntyScore({
      objectives: withSeal(fullMarksObjectives(), "SEAL2"),
    }),
  );
  assertEquals(r.floorsEvaluated, false);
  assertEquals(r.floorsPassed, true);
  assertEquals(r.objectivesBelowFloor, []);
});

Deno.test("computeSovereigntyScore: caller-supplied SEAL floors pass when every achieved SEAL meets its floor", () => {
  const r = asScore(computeSovereigntyScore({
    objectives: withSeal(fullMarksObjectives(), "SEAL2"),
    sealFloors: { "SOV-1": "SEAL1", "SOV-5": "SEAL2" },
  }));
  assertEquals(r.floorsEvaluated, true);
  assertEquals(r.floorsPassed, true);
  assertEquals(r.objectivesBelowFloor, []);
});

Deno.test("computeSovereigntyScore: caller-supplied SEAL floors fail and NAME every objective below its floor", () => {
  const r = asScore(computeSovereigntyScore({
    objectives: withSeal(fullMarksObjectives(), "SEAL2"),
    sealFloors: { "SOV-3": "SEAL3", "SOV-6": "SEAL4", "SOV-1": "SEAL1" },
  }));
  assertEquals(r.floorsEvaluated, true);
  assertEquals(r.floorsPassed, false);
  assertEquals(r.objectivesBelowFloor.slice().sort(), ["SOV-3", "SOV-6"]);
});

Deno.test("computeSovereigntyScore: SEAL floors are never hardcoded — the SAME achieved SEAL passes or fails purely based on the caller-supplied floor", () => {
  const objectives = withSeal(fullMarksObjectives(), "SEAL1");
  const lenient = asScore(
    computeSovereigntyScore({ objectives, sealFloors: { "SOV-1": "SEAL0" } }),
  );
  const strict = asScore(
    computeSovereigntyScore({ objectives, sealFloors: { "SOV-1": "SEAL4" } }),
  );
  assertEquals(lenient.floorsPassed, true);
  assertEquals(strict.floorsPassed, false);
  assertEquals(strict.objectivesBelowFloor, ["SOV-1"]);
});

const SEAL_TOKENS = ["SEAL0", "SEAL1", "SEAL2", "SEAL3", "SEAL4"];
const SEAL_DUTCH: Record<string, string> = {
  "SEAL0": "Geen soevereiniteit",
  "SEAL1": "Jurisdictionele soevereiniteit",
  "SEAL2": "Data-soevereiniteit",
  "SEAL3": "Digitale veerkracht",
  "SEAL4": "Volledige digitale soevereiniteit",
};

Deno.test("SEAL_LABELS is exhaustive over SEAL0..SEAL4, each with a non-empty English label and the official Dutch rendering", () => {
  assertEquals(Object.keys(SEAL_LABELS).sort(), [...SEAL_TOKENS].sort());
  const labels = SEAL_LABELS as Record<string, { en: string; nl: string }>;
  for (const token of SEAL_TOKENS) {
    const label = labels[token];
    assert(label, `missing SEAL_LABELS entry for ${token}`);
    assert(label.en.length > 0, `${token} missing English label`);
    assertEquals(label.nl, SEAL_DUTCH[token]);
  }
});

// =============================================================================
// 2. evaluateCloudEligibility(input) — Herziening rijksbreed cloudbeleid 2026
// =============================================================================

interface CloudEligibilityInput {
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
}

interface CloudEligibilityResult {
  verdict: "allowed" | "conditional" | "discouraged" | "prohibited";
  clauses: string[];
  reason: string;
  clause45?: {
    continuityEstablishedIndependently: boolean;
    riskAnalysisAndExitPlanTested: boolean;
    ministerialApprovalObtained: boolean;
    allMet: boolean;
  };
}

function baselineInput(
  overrides: Partial<CloudEligibilityInput> = {},
): CloudEligibilityInput {
  return {
    rubricering: "Ongerubriceerd",
    processingRegion: "EEA",
    supplierJurisdiction: "EU",
    isPrimaryProcess: false,
    isBasisregistratie: false,
    isEmailOrWorkplace: false,
    continuityEstablishedIndependently: false,
    riskAnalysisAndExitPlanTested: false,
    ministerialApprovalObtained: false,
    isVitaleAanbieder: false,
    isWwkeEntity: false,
    isCbwEssentialEntity: false,
    ...overrides,
  };
}

function asResult(x: unknown): CloudEligibilityResult {
  return x as CloudEligibilityResult;
}

function assertReason(r: CloudEligibilityResult) {
  assert(
    typeof r.reason === "string" && r.reason.trim().length > 0,
    "reason must be a non-empty human-readable string",
  );
}

// ---------- allowed --------------------------------------------------------

Deno.test("evaluateCloudEligibility: Ongerubriceerd + EEA processing + no other trigger is allowed", () => {
  const r = asResult(evaluateCloudEligibility(baselineInput()));
  assertEquals(r.verdict, "allowed");
  assertEquals(r.clauses, []);
  assertEquals(r.clause45, undefined);
  assertReason(r);
});

Deno.test("evaluateCloudEligibility: TBB 4 alone (rubricering omitted) + EEA processing + no other trigger is allowed", () => {
  const r = asResult(
    evaluateCloudEligibility(
      baselineInput({ rubricering: undefined, tbbCategory: "TBB 4" }),
    ),
  );
  assertEquals(r.verdict, "allowed");
  assertReason(r);
});

Deno.test("evaluateCloudEligibility: Switzerland processing is treated as EEA-equivalent and stays allowed (all else compliant)", () => {
  const r = asResult(
    evaluateCloudEligibility(
      baselineInput({ processingRegion: "Switzerland" }),
    ),
  );
  assertEquals(r.verdict, "allowed");
});

// ---------- prohibited ------------------------------------------------------

for (
  const staatsgeheim of [
    "Stg. CONFIDENTIEEL",
    "Stg. GEHEIM",
    "Stg. ZEER GEHEIM",
  ]
) {
  Deno.test(`evaluateCloudEligibility: staatsgeheim rubricering "${staatsgeheim}" is prohibited`, () => {
    const r = asResult(
      evaluateCloudEligibility(baselineInput({ rubricering: staatsgeheim })),
    );
    assertEquals(r.verdict, "prohibited");
    assert(r.clauses.length > 0);
    assertReason(r);
  });
}

for (const tbb of ["TBB 1", "TBB 2", "TBB 3"]) {
  Deno.test(`evaluateCloudEligibility: ${tbb} is prohibited`, () => {
    const r = asResult(
      evaluateCloudEligibility(
        baselineInput({ rubricering: undefined, tbbCategory: tbb }),
      ),
    );
    assertEquals(r.verdict, "prohibited");
    assert(r.clauses.length > 0);
    assertReason(r);
  });
}

Deno.test("evaluateCloudEligibility: basisregistratie source data is prohibited", () => {
  const r = asResult(
    evaluateCloudEligibility(baselineInput({ isBasisregistratie: true })),
  );
  assertEquals(r.verdict, "prohibited");
  assertReason(r);
});

Deno.test("evaluateCloudEligibility: processing outside the EEA and Switzerland is prohibited", () => {
  const r = asResult(
    evaluateCloudEligibility(
      baselineInput({ processingRegion: "United States" }),
    ),
  );
  assertEquals(r.verdict, "prohibited");
  assertReason(r);
});

Deno.test("evaluateCloudEligibility: Caribisch Nederland is NOT covered by the EEA residency rule — same prohibition as any other non-EEA region", () => {
  const r = asResult(
    evaluateCloudEligibility(
      baselineInput({ processingRegion: "Caribisch Nederland" }),
    ),
  );
  assertEquals(r.verdict, "prohibited");
  assertReason(r);
});

Deno.test("evaluateCloudEligibility: contradictory input (rubricering=Stg. GEHEIM, tbbCategory=TBB 4) resolves to the most restrictive verdict — the lenient TBB category does not water it down", () => {
  const r = asResult(
    evaluateCloudEligibility(
      baselineInput({ rubricering: "Stg. GEHEIM", tbbCategory: "TBB 4" }),
    ),
  );
  assertEquals(r.verdict, "prohibited");
});

// ---------- conditional (clause 4.5: email / workplace) --------------------

const CLAUSE_45_PARTIAL_CASES = [
  { met: 0, continuity: false, risk: false, ministerial: false },
  { met: 1, continuity: true, risk: false, ministerial: false },
  { met: 2, continuity: true, risk: true, ministerial: false },
];

for (const c of CLAUSE_45_PARTIAL_CASES) {
  Deno.test(`evaluateCloudEligibility: email/workplace storage with ${c.met}-of-3 clause-4.5 conditions met stays conditional (not allowed)`, () => {
    const r = asResult(evaluateCloudEligibility(baselineInput({
      isEmailOrWorkplace: true,
      continuityEstablishedIndependently: c.continuity,
      riskAnalysisAndExitPlanTested: c.risk,
      ministerialApprovalObtained: c.ministerial,
    })));
    assertEquals(r.verdict, "conditional");
    assert(
      r.clause45,
      "clause45 detail must be reported whenever isEmailOrWorkplace is true",
    );
    assertEquals(r.clause45?.continuityEstablishedIndependently, c.continuity);
    assertEquals(r.clause45?.riskAnalysisAndExitPlanTested, c.risk);
    assertEquals(r.clause45?.ministerialApprovalObtained, c.ministerial);
    assertEquals(r.clause45?.allMet, false);
    assertReason(r);
  });
}

Deno.test("evaluateCloudEligibility: email/workplace storage with 3-of-3 clause-4.5 conditions met is the boundary that flips the verdict away from conditional", () => {
  const r = asResult(evaluateCloudEligibility(baselineInput({
    isEmailOrWorkplace: true,
    continuityEstablishedIndependently: true,
    riskAnalysisAndExitPlanTested: true,
    ministerialApprovalObtained: true,
  })));
  assertEquals(r.verdict, "allowed");
  assert(r.clause45);
  assertEquals(r.clause45?.allMet, true);
});

// ---------- discouraged (clause 4.3) ----------------------------------------

Deno.test("evaluateCloudEligibility: isVitaleAanbieder + primary process + non-EU/EEA supplier jurisdiction is discouraged (the distinct fourth value, not folded into prohibited/conditional)", () => {
  const r = asResult(evaluateCloudEligibility(baselineInput({
    isVitaleAanbieder: true,
    isPrimaryProcess: true,
    supplierJurisdiction: "United States",
  })));
  assertEquals(r.verdict, "discouraged");
  assert(
    r.clauses.some((c) => c.includes("4.3")),
    `expected a 4.3 citation, got: ${r.clauses.join(", ")}`,
  );
  assertReason(r);
});

Deno.test("evaluateCloudEligibility: isWwkeEntity + primary process + non-EU/EEA supplier jurisdiction is discouraged", () => {
  const r = asResult(evaluateCloudEligibility(baselineInput({
    isWwkeEntity: true,
    isPrimaryProcess: true,
    supplierJurisdiction: "United States",
  })));
  assertEquals(r.verdict, "discouraged");
  assert(r.clauses.some((c) => c.includes("4.3")));
});

Deno.test("evaluateCloudEligibility: isCbwEssentialEntity + primary process + non-EU/EEA supplier jurisdiction is discouraged", () => {
  const r = asResult(evaluateCloudEligibility(baselineInput({
    isCbwEssentialEntity: true,
    isPrimaryProcess: true,
    supplierJurisdiction: "United States",
  })));
  assertEquals(r.verdict, "discouraged");
  assert(r.clauses.some((c) => c.includes("4.3")));
});

Deno.test("evaluateCloudEligibility: the discouraged rule does NOT fire when isPrimaryProcess is false, even with a non-EU/EEA supplier and an entity-type flag set", () => {
  const r = asResult(evaluateCloudEligibility(baselineInput({
    isVitaleAanbieder: true,
    isPrimaryProcess: false,
    supplierJurisdiction: "United States",
  })));
  assertEquals(r.verdict, "allowed");
});

// ---------- discouraged (clause 4.3): independent-leg negative coverage ----
//
// Test review round 1, HIGH: the discouraged rule is a three-way AND over
// (a) supplierJurisdiction outside EU/EEA, (b) at least one entity-type flag,
// (c) isPrimaryProcess. The suite above only negative-tested leg (c) — an
// implementation that ignored supplierJurisdiction entirely, or ignored the
// entity-type flags entirely, would still pass every test above (ALL of
// them keep supplierJurisdiction fixed at a non-EU value and an entity flag
// fixed at true, so a hardcoded "entity-flag + primary => discouraged"
// implementation that never reads supplierJurisdiction was never caught).
// These tests close that gap: leg (a) and leg (b) are now negative-tested
// independently, PER entity-type flag, so an implementation honouring only
// isVitaleAanbieder and silently ignoring isWwkeEntity/isCbwEssentialEntity
// is also caught on the negative side (not just via the positive per-flag
// tests above).

const ENTITY_FLAGS = [
  "isVitaleAanbieder",
  "isWwkeEntity",
  "isCbwEssentialEntity",
] as const;
type EntityFlag = typeof ENTITY_FLAGS[number];

function entityFlagOverride(flag: EntityFlag): Partial<CloudEligibilityInput> {
  switch (flag) {
    case "isVitaleAanbieder":
      return { isVitaleAanbieder: true };
    case "isWwkeEntity":
      return { isWwkeEntity: true };
    case "isCbwEssentialEntity":
      return { isCbwEssentialEntity: true };
  }
}

Deno.test("evaluateCloudEligibility: non-EU/EEA supplier jurisdiction + primary process but NO entity-type flag set is NOT discouraged — leg (b) is load-bearing, not vestigial (an implementation ignoring the entity flags entirely would wrongly fire here)", () => {
  const r = asResult(evaluateCloudEligibility(baselineInput({
    isPrimaryProcess: true,
    supplierJurisdiction: "United States",
    // isVitaleAanbieder / isWwkeEntity / isCbwEssentialEntity all false (baseline default)
  })));
  assertEquals(r.verdict, "allowed");
  assert(!r.clauses.some((c) => c.includes("4.3")));
});

for (const flag of ENTITY_FLAGS) {
  Deno.test(`evaluateCloudEligibility: ${flag} + primary process but an EU/EEA supplier jurisdiction is NOT discouraged — leg (a) is load-bearing, not vestigial (an implementation ignoring supplierJurisdiction entirely would wrongly fire here)`, () => {
    const r = asResult(evaluateCloudEligibility(baselineInput({
      ...entityFlagOverride(flag),
      isPrimaryProcess: true,
      supplierJurisdiction: "EU",
    })));
    assertEquals(r.verdict, "allowed");
    assert(!r.clauses.some((c) => c.includes("4.3")));
  });
}

for (const flag of ENTITY_FLAGS) {
  Deno.test(`evaluateCloudEligibility: ${flag} + non-EU/EEA supplier jurisdiction but isPrimaryProcess=false is NOT discouraged — leg (c) is load-bearing, tested per entity flag (not just isVitaleAanbieder)`, () => {
    const r = asResult(evaluateCloudEligibility(baselineInput({
      ...entityFlagOverride(flag),
      isPrimaryProcess: false,
      supplierJurisdiction: "United States",
    })));
    assertEquals(r.verdict, "allowed");
    assert(!r.clauses.some((c) => c.includes("4.3")));
  });
}

for (const flag of ENTITY_FLAGS) {
  Deno.test(`evaluateCloudEligibility: ${flag} + non-EU/EEA supplier jurisdiction + primary process (all three legs true) is discouraged`, () => {
    const r = asResult(evaluateCloudEligibility(baselineInput({
      ...entityFlagOverride(flag),
      isPrimaryProcess: true,
      supplierJurisdiction: "United States",
    })));
    assertEquals(r.verdict, "discouraged");
    assert(r.clauses.some((c) => c.includes("4.3")));
  });
}

Deno.test("evaluateCloudEligibility: supplierJurisdiction and processingRegion are INDEPENDENT — an explicit EEA processingRegion does not suppress clause 4.3 when supplierJurisdiction is non-EU/EEA (a single conflated region input would miss this)", () => {
  const r = asResult(evaluateCloudEligibility(baselineInput({
    isVitaleAanbieder: true,
    isPrimaryProcess: true,
    processingRegion: "EEA", // explicit — compliant on its own
    supplierJurisdiction: "United States", // the actual clause-4.3 trigger
  })));
  assertEquals(r.verdict, "discouraged");
  assert(r.clauses.some((c) => c.includes("4.3")));
});

Deno.test("evaluateCloudEligibility: the converse independence check — a non-EEA processingRegion is independently prohibited even when supplierJurisdiction is EU-compliant (proves processingRegion drives the prohibited verdict, not a reused/swapped supplierJurisdiction value)", () => {
  const r = asResult(evaluateCloudEligibility(baselineInput({
    isVitaleAanbieder: true,
    isPrimaryProcess: true,
    processingRegion: "United States", // fires the EEA-residency prohibition
    supplierJurisdiction: "EU", // compliant on its own — would NOT fire 4.3 alone
  })));
  assertEquals(r.verdict, "prohibited");
});

// ---------- most-restrictive-wins / strict total order ----------------------

Deno.test("evaluateCloudEligibility: an input firing BOTH a discouraged rule and a prohibited rule resolves to prohibited, with clauses containing both", () => {
  const r = asResult(evaluateCloudEligibility(baselineInput({
    isVitaleAanbieder: true,
    isPrimaryProcess: true,
    supplierJurisdiction: "United States", // fires discouraged (4.3)
    isBasisregistratie: true, // fires prohibited
  })));
  assertEquals(r.verdict, "prohibited");
  assert(
    r.clauses.length >= 2,
    `expected both fired rules cited, got: ${r.clauses.join(", ")}`,
  );
  assert(r.clauses.some((c) => c.includes("4.3")));
});

Deno.test("evaluateCloudEligibility: conditional (email/workplace, 0-of-3) + discouraged (vitale aanbieder, non-EU supplier) co-firing resolves to conditional — conditional outranks discouraged", () => {
  const r = asResult(evaluateCloudEligibility(baselineInput({
    isEmailOrWorkplace: true,
    isVitaleAanbieder: true,
    isPrimaryProcess: true,
    supplierJurisdiction: "United States",
  })));
  assertEquals(r.verdict, "conditional");
  assert(
    r.clauses.length >= 2,
    `expected both fired rules cited, got: ${r.clauses.join(", ")}`,
  );
});

Deno.test("evaluateCloudEligibility: prohibited (basisregistratie) + conditional (email/workplace, 0-of-3) co-firing resolves to prohibited — prohibited outranks everything", () => {
  const r = asResult(evaluateCloudEligibility(baselineInput({
    isBasisregistratie: true,
    isEmailOrWorkplace: true,
  })));
  assertEquals(r.verdict, "prohibited");
  assert(
    r.clauses.length >= 2,
    `expected both fired rules cited, got: ${r.clauses.join(", ")}`,
  );
});

// ---------- fail-closed ------------------------------------------------------

Deno.test("evaluateCloudEligibility rejects when neither rubricering nor tbbCategory is supplied", () => {
  assertThrows(() =>
    evaluateCloudEligibility(baselineInput({ rubricering: undefined }))
  );
});

Deno.test("evaluateCloudEligibility rejects an unrecognized rubricering value, listing the valid set", () => {
  const err = assertThrows(
    () =>
      evaluateCloudEligibility(baselineInput({ rubricering: "TOP SECRET" })),
    Error,
  );
  assert(
    err.message.includes("Ongerubriceerd"),
    `error should list the valid rubricering set, got: ${err.message}`,
  );
});

Deno.test("evaluateCloudEligibility rejects an unrecognized tbbCategory value, listing the valid set", () => {
  const err = assertThrows(
    () =>
      evaluateCloudEligibility(
        baselineInput({ rubricering: undefined, tbbCategory: "TBB 5" }),
      ),
    Error,
  );
  assert(
    err.message.includes("TBB"),
    `error should list the valid TBB set, got: ${err.message}`,
  );
});

const REQUIRED_KEYS = [
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

function callEligibilityRaw(input: Record<string, unknown>): unknown {
  const fn = evaluateCloudEligibility as unknown as (
    i: Record<string, unknown>,
  ) => unknown;
  return fn(input);
}

for (const key of REQUIRED_KEYS) {
  Deno.test(`evaluateCloudEligibility fail-closed table: omitting required argument "${key}" is rejected, not silently defaulted to the permissive value (guards against a LATER-added input silently acquiring a permissive default)`, () => {
    const input: Record<string, unknown> = { ...baselineInput() };
    delete input[key];
    assertThrows(() => callEligibilityRaw(input));
  });
}

// ---------- clause-citation regression pin (code review finding, HIGH) ------
//
// evaluateCloudEligibility's fired clauses must cite the ACTUAL Rijksbreed
// cloudbeleid 2026 (Ministerie van EZK, 3 juli 2026, definitief) section
// numbers, matching the bundled templates. A prior revision hardcoded the
// WRONG numbers for three of the five rules: residency cited §4.1 instead of
// §4.6; staatsgeheim/TBB cited §4.2 instead of §5.2 (§4.2 is Cyberveiligheid
// — C2000/ABRO/AIVD-MIVD criteria, NOT classification); basisregistratie
// cited §4.4 instead of §5.4. This table pins the exact section number per
// rule (not merely "an array of citations") so a future edit cannot silently
// drift the numbering back to the wrong values.

function extractClauseNumbers(clauses: string[]): string[] {
  const nums: string[] = [];
  for (const c of clauses) {
    const m = c.match(/§(\d+\.\d+)/);
    if (m) nums.push(m[1]);
  }
  return nums;
}

const CLAUSE_CITATION_CASES: Array<
  { name: string; overrides: Partial<CloudEligibilityInput>; clause: string }
> = [
  {
    name: "staatsgeheim rubricering cites exactly §5.2",
    overrides: { rubricering: "Stg. GEHEIM" },
    clause: "5.2",
  },
  {
    name: "TBB 1 (prohibited category) cites exactly §5.2",
    overrides: { rubricering: undefined, tbbCategory: "TBB 1" },
    clause: "5.2",
  },
  {
    name: "basisregistratie source data cites exactly §5.4",
    overrides: { isBasisregistratie: true },
    clause: "5.4",
  },
  {
    name: "non-EEA/Switzerland processing region cites exactly §4.6",
    overrides: { processingRegion: "United States" },
    clause: "4.6",
  },
  {
    name: "vitale aanbieder / Wwke / Cbw discouraged rule cites exactly §4.3",
    overrides: {
      isVitaleAanbieder: true,
      isPrimaryProcess: true,
      supplierJurisdiction: "United States",
    },
    clause: "4.3",
  },
  {
    name: "email/workplace conditional rule cites exactly §4.5",
    overrides: { isEmailOrWorkplace: true },
    clause: "4.5",
  },
];

for (const c of CLAUSE_CITATION_CASES) {
  Deno.test(
    `evaluateCloudEligibility clause citation regression pin: ${c.name}`,
    () => {
      const r = asResult(
        evaluateCloudEligibility(baselineInput(c.overrides)),
      );
      const nums = extractClauseNumbers(r.clauses);
      assert(
        nums.includes(c.clause),
        `expected a §${c.clause} citation, got clause numbers: ${
          nums.join(", ")
        } (full clauses: ${r.clauses.join(" | ")})`,
      );
    },
  );
}

Deno.test("evaluateCloudEligibility clause citation regression pin: the classification/residency/basisregistratie rules never cite §4.1, §4.2 or §4.4 — the exact wrong section numbers this pin corrects", () => {
  const casesToCheck: CloudEligibilityInput[] = [
    baselineInput({ rubricering: "Stg. ZEER GEHEIM" }), // was wrongly §4.2
    baselineInput({ rubricering: undefined, tbbCategory: "TBB 2" }), // was wrongly §4.2
    baselineInput({ isBasisregistratie: true }), // was wrongly §4.4
    baselineInput({ processingRegion: "United States" }), // was wrongly §4.1
  ];
  for (const input of casesToCheck) {
    const r = asResult(evaluateCloudEligibility(input));
    const nums = extractClauseNumbers(r.clauses);
    for (const wrong of ["4.1", "4.2", "4.4"]) {
      assert(
        !nums.includes(wrong),
        `clause numbers must never include §${wrong}, got: ${
          nums.join(", ")
        } (full clauses: ${r.clauses.join(" | ")})`,
      );
    }
  }
});

// =============================================================================
// Swamp METHODS: euSovereigntyScore / nlCloudEligibility
// (test review round 1, HIGH: the pure functions were tested but the two
// swamp methods that wrap them — the actual thing a caller invokes via
// `swamp model method run` — were not. Added per the approved testStrategy.)
// =============================================================================

// ---------- euSovereigntyScore ----------------------------------------------

Deno.test("methods: euSovereigntyScore writes a sovereigntyAssessment resource named sovereignty-${slugify(subject)} when no project is given", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "euSovereigntyScore", {
      subject: "Acme Cloud B.V.",
      objectives: fullMarksObjectives(),
    }, ctx);
    assertEquals(written[0].spec, "sovereigntyAssessment");
    assertEquals(written[0].name, `sovereignty-${slugify("Acme Cloud B.V.")}`);
  });
});

Deno.test("methods: euSovereigntyScore prefixes the resource name with the project when given, mirroring projectStatus's ${project}-status shape", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "euSovereigntyScore", {
      subject: "Acme Cloud B.V.",
      project: "001-x",
      objectives: fullMarksObjectives(),
    }, ctx);
    assertEquals(
      written[0].name,
      `001-x-sovereignty-${slugify("Acme Cloud B.V.")}`,
    );
  });
});

Deno.test("methods: euSovereigntyScore's resource name uses the file's existing exported slugify() for the subject — not a second ad-hoc slug helper", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    const subject = "  Acme Cloud, B.V. (NL) — Tier-1!! ";
    await run(model, "euSovereigntyScore", {
      subject,
      objectives: fullMarksObjectives(),
    }, ctx);
    // Asserted against slugify(subject) directly, not a hand-copied literal —
    // if the implementation used a DIFFERENT slugging rule (or a second
    // helper with different punctuation/whitespace handling), this fails
    // even though a hand-picked "obviously already kebab-case" subject would
    // not have caught it.
    assertEquals(written[0].name, `sovereignty-${slugify(subject)}`);
  });
});

Deno.test("methods: euSovereigntyScore logs a one-line summary via context.logger.info carrying the computed score", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, logs } = makeCtx(root, templatesDir);
    await run(model, "euSovereigntyScore", {
      subject: "Acme",
      objectives: fullMarksObjectives(),
    }, ctx);
    assert(logs.length > 0, "expected at least one context.logger.info call");
    const scoreLogged = logs.some((l) => {
      const score = l.fields?.score;
      return typeof score === "number" && Math.abs(score - 100) < 0.01;
    });
    assert(
      scoreLogged,
      `expected a log entry with fields.score≈100 (full marks), got: ${
        JSON.stringify(logs)
      }`,
    );
  });
});

Deno.test("methods: euSovereigntyScore's written payload carries the per-objective evidence field through from the arguments", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    const objectives = fullMarksObjectives().map((o) =>
      o.id === "SOV-1"
        ? { ...o, evidence: "ISO 27001:2023 certificate; EU-based operations" }
        : o
    );
    await run(
      model,
      "euSovereigntyScore",
      { subject: "Acme", objectives },
      ctx,
    );
    const payload = written[0].payload as Record<string, unknown>;
    const breakdown = payload.breakdown as Array<Record<string, unknown>>;
    const entry = breakdown.find((b) => b.id === "SOV-1");
    assert(entry, "breakdown missing SOV-1");
    assertEquals(
      entry!.evidence,
      "ISO 27001:2023 certificate; EU-based operations",
    );
  });
});

Deno.test("methods: euSovereigntyScore's written payload carries the per-objective caller-supplied SEAL through from the arguments (code review finding, MEDIUM: a claimed SEAL used for the floor check must also be recorded, not silently dropped)", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    const objectives = fullMarksObjectives().map((o) =>
      o.id === "SOV-3" ? { ...o, seal: "SEAL2" } : o
    );
    await run(
      model,
      "euSovereigntyScore",
      { subject: "Acme", objectives },
      ctx,
    );
    const payload = written[0].payload as Record<string, unknown>;
    const breakdown = payload.breakdown as Array<Record<string, unknown>>;
    const entry = breakdown.find((b) => b.id === "SOV-3");
    assert(entry, "breakdown missing SOV-3");
    assertEquals(entry!.seal, "SEAL2");
    // An objective with no caller-supplied SEAL must not fabricate one.
    const unsealed = breakdown.find((b) => b.id === "SOV-1");
    assert(unsealed, "breakdown missing SOV-1");
    assertEquals(unsealed!.seal, undefined);
  });
});

Deno.test("methods: euSovereigntyScore computes an assessment, it does not certify — the written payload carries no attestation/certified field", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "euSovereigntyScore", {
      subject: "Acme",
      objectives: fullMarksObjectives(),
    }, ctx);
    const payload = written[0].payload as Record<string, unknown>;
    assertEquals(payload.certified, undefined);
    assertEquals(payload.attestation, undefined);
    assertEquals(payload.attested, undefined);
  });
});

Deno.test("methods: euSovereigntyScore's arguments go through zod parsing via run() — omitting the required subject is rejected before execute() runs, and nothing is written", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await assertRejects(() =>
      run(model, "euSovereigntyScore", {
        objectives: fullMarksObjectives(),
      }, ctx)
    );
    assertEquals(written.length, 0);
  });
});

Deno.test("methods: euSovereigntyScore's arguments go through zod parsing via run() — omitting the required objectives is rejected before execute() runs", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await assertRejects(() =>
      run(model, "euSovereigntyScore", { subject: "Acme" }, ctx)
    );
    assertEquals(written.length, 0);
  });
});

// ---------- nlCloudEligibility ----------------------------------------------

/**
 * Flattens a CloudEligibilityInput onto the nlCloudEligibility method's
 * assumed args shape (`{ subject, project? } & CloudEligibilityInput`) —
 * mirrors baselineInput() so every pure-function scenario above is directly
 * reusable at the method level.
 */
function cloudEligibilityMethodArgs(
  subject: string,
  overrides: Partial<CloudEligibilityInput> = {},
  project?: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    subject,
    ...baselineInput(overrides),
  };
  if (project !== undefined) args.project = project;
  return args;
}

Deno.test("methods: nlCloudEligibility writes a cloudEligibility resource named cloud-eligibility-${slugify(subject)} when no project is given", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(
      model,
      "nlCloudEligibility",
      cloudEligibilityMethodArgs("Acme Cloud B.V."),
      ctx,
    );
    assertEquals(written[0].spec, "cloudEligibility");
    assertEquals(
      written[0].name,
      `cloud-eligibility-${slugify("Acme Cloud B.V.")}`,
    );
  });
});

Deno.test("methods: nlCloudEligibility prefixes the resource name with the project when given, mirroring projectStatus's ${project}-status shape", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(
      model,
      "nlCloudEligibility",
      cloudEligibilityMethodArgs("Acme Cloud B.V.", {}, "001-x"),
      ctx,
    );
    assertEquals(
      written[0].name,
      `001-x-cloud-eligibility-${slugify("Acme Cloud B.V.")}`,
    );
  });
});

Deno.test("methods: nlCloudEligibility's resource name uses the file's existing exported slugify() for the subject — not a second ad-hoc slug helper", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    const subject = "  Acme Cloud, B.V. (NL) — Tier-1!! ";
    await run(
      model,
      "nlCloudEligibility",
      cloudEligibilityMethodArgs(subject),
      ctx,
    );
    assertEquals(written[0].name, `cloud-eligibility-${slugify(subject)}`);
  });
});

Deno.test("methods: nlCloudEligibility logs a one-line summary via context.logger.info carrying the computed verdict", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, logs } = makeCtx(root, templatesDir);
    await run(
      model,
      "nlCloudEligibility",
      cloudEligibilityMethodArgs("Acme", { isBasisregistratie: true }),
      ctx,
    );
    assert(logs.length > 0, "expected at least one context.logger.info call");
    const verdictLogged = logs.some((l) => l.fields?.verdict === "prohibited");
    assert(
      verdictLogged,
      `expected a log entry with fields.verdict==="prohibited", got: ${
        JSON.stringify(logs)
      }`,
    );
  });
});

Deno.test("methods: nlCloudEligibility's arguments go through zod parsing via run() — omitting the required subject is rejected before execute() runs, and nothing is written", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    const args = cloudEligibilityMethodArgs("placeholder");
    delete args.subject;
    await assertRejects(() => run(model, "nlCloudEligibility", args, ctx));
    assertEquals(written.length, 0);
  });
});

Deno.test("methods: nlCloudEligibility's arguments go through zod parsing via run() — omitting a required governance input (processingRegion) is rejected before execute() runs", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    const args = cloudEligibilityMethodArgs("Acme");
    delete args.processingRegion;
    await assertRejects(() => run(model, "nlCloudEligibility", args, ctx));
    assertEquals(written.length, 0);
  });
});

Deno.test("methods: nlCloudEligibility rejects an unrecognized rubricering value AT THE ARGUMENT SCHEMA (zod enum) via run() — matching startProject's existing profile: z.enum(PROFILES) convention, before execute() runs", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    const args = cloudEligibilityMethodArgs("Acme", {
      rubricering: "TOP SECRET", // not a valid NL rubricering enum value
    });
    await assertRejects(() => run(model, "nlCloudEligibility", args, ctx));
    assertEquals(written.length, 0);
  });
});

Deno.test("methods: nlCloudEligibility rejects an unrecognized tbbCategory value AT THE ARGUMENT SCHEMA (zod enum) via run(), before execute() runs", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    const args = cloudEligibilityMethodArgs("Acme", {
      rubricering: undefined,
      tbbCategory: "TBB 5",
    });
    await assertRejects(() => run(model, "nlCloudEligibility", args, ctx));
    assertEquals(written.length, 0);
  });
});

Deno.test("methods: nlCloudEligibility's project argument is optional — both the with-project and without-project call shapes are accepted by the arg schema via run()", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx: ctxNoProject, written: writtenNoProject } = makeCtx(
      root,
      templatesDir,
    );
    await run(
      model,
      "nlCloudEligibility",
      cloudEligibilityMethodArgs("Acme"),
      ctxNoProject,
    );
    assertEquals(writtenNoProject.length, 1);

    const { ctx: ctxWithProject, written: writtenWithProject } = makeCtx(
      root,
      templatesDir,
    );
    await run(
      model,
      "nlCloudEligibility",
      cloudEligibilityMethodArgs("Acme", {}, "001-x"),
      ctxWithProject,
    );
    assertEquals(writtenWithProject.length, 1);
  });
});
