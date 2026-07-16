import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  COMMAND_TO_CODE,
  computeGaps,
  CRITICAL_PATH,
  DOC_CODES,
  evaluateGate,
  gateFor,
  MANDATORY_DEPS,
  nextPhase,
  nextProjectDir,
  parseArtifactFilename,
  parseProjectDir,
  PHASE_GATES,
  PHASES,
  proposeClassification,
  slugify,
  TEMPLATE_MAP,
} from "./arckit_workspace.ts";

// ---------- parseArtifactFilename --------------------------------------------

Deno.test("parses a simple requirements artifact", () => {
  const a = parseArtifactFilename("ARC-001-REQ-v1.0.md");
  assert(a);
  assertEquals(a.projectId, "001");
  assertEquals(a.docType, "REQ");
  assertEquals(a.command, "requirements");
  assertEquals(a.version, "1.0");
  assertEquals(a.instance, undefined);
});

Deno.test("longest-match wins for hyphenated codes (PRIN-COMP vs PRIN)", () => {
  const a = parseArtifactFilename("ARC-001-PRIN-COMP-v2.1.md");
  assert(a);
  assertEquals(a.docType, "PRIN-COMP");
  assertEquals(a.command, "principles-compliance");
});

Deno.test("longest-match wins for SECD-MOD vs SECD", () => {
  const a = parseArtifactFilename("ARC-003-SECD-MOD-v1.0.md");
  assert(a);
  assertEquals(a.command, "mod-secure");
  const b = parseArtifactFilename("ARC-003-SECD-v1.0.md");
  assert(b);
  assertEquals(b.command, "secure");
});

Deno.test("multi-instance artifacts carry an instance number", () => {
  const a = parseArtifactFilename("ARC-002-DFD-2-v1.0.md");
  assert(a);
  assertEquals(a.docType, "DFD");
  assertEquals(a.instance, 2);
  const b = parseArtifactFilename("ARC-002-WCLM-11-v1.3.md");
  assert(b);
  assertEquals(b.command, "wardley.climate");
  assertEquals(b.instance, 11);
});

Deno.test("global principles artifact parses", () => {
  const a = parseArtifactFilename("ARC-000-PRIN-v1.0.md");
  assert(a);
  assertEquals(a.projectId, "000");
  assertEquals(a.command, "principles");
});

Deno.test("backlog JSON export is recognized", () => {
  const a = parseArtifactFilename("ARC-004-BKLG-v1.0.json");
  assert(a);
  assertEquals(a.command, "backlog");
});

Deno.test("unknown doc code is kept but unmapped", () => {
  const a = parseArtifactFilename("ARC-001-ZZZZ-v1.0.md");
  assert(a);
  assertEquals(a.docType, "ZZZZ");
  assertEquals(a.command, undefined);
});

Deno.test("non-ARC files return null", () => {
  assertEquals(parseArtifactFilename("notes.md"), null);
  assertEquals(parseArtifactFilename("ARC-001-REQ.md"), null); // no version
  assertEquals(parseArtifactFilename("ARC-1-REQ-v1.0.md"), null); // id not 3 digits
});

// ---------- parseProjectDir ---------------------------------------------------

Deno.test("parses numbered project directories", () => {
  const p = parseProjectDir("001-payment-gateway");
  assert(p);
  assertEquals(p.id, "001");
  assertEquals(p.name, "payment-gateway");
  assertEquals(p.isGlobal, false);
  const g = parseProjectDir("000-global");
  assert(g);
  assertEquals(g.isGlobal, true);
  assertEquals(parseProjectDir("scratch"), null);
});

// ---------- computeGaps -------------------------------------------------------

Deno.test("risk without stakeholders is a violation", () => {
  const gaps = computeGaps([
    { dir: "001-x", id: "001", name: "x", isGlobal: false, commands: ["risk"] },
  ]);
  const p = gaps.projects[0];
  assertEquals(p.violations, [{
    command: "risk",
    missingMandatory: ["stakeholders"],
  }]);
});

Deno.test("global principles satisfy per-project mandatory deps", () => {
  const gaps = computeGaps([
    {
      dir: "000-global",
      id: "000",
      name: "global",
      isGlobal: true,
      commands: ["principles"],
    },
    {
      dir: "001-x",
      id: "001",
      name: "x",
      isGlobal: false,
      commands: ["analyze"],
    },
  ]);
  const p = gaps.projects.find((x) => x.dir === "001-x");
  assert(p);
  assertEquals(p.violations, []);
});

Deno.test("evaluate requires both requirements and sow", () => {
  const gaps = computeGaps([
    {
      dir: "001-x",
      id: "001",
      name: "x",
      isGlobal: false,
      commands: ["evaluate", "requirements"],
    },
  ]);
  assertEquals(gaps.projects[0].violations, [{
    command: "evaluate",
    missingMandatory: ["sow"],
  }]);
});

Deno.test("wardley sub-maps require the base wardley map", () => {
  const gaps = computeGaps([
    {
      dir: "001-x",
      id: "001",
      name: "x",
      isGlobal: false,
      commands: ["wardley.climate", "wardley.gameplay"],
    },
  ]);
  const missing = gaps.projects[0].violations.map((v) => v.missingMandatory);
  assertEquals(missing, [["wardley"], ["wardley"]]);
});

Deno.test("nextOnCriticalPath is the first missing step", () => {
  const gaps = computeGaps([
    {
      dir: "000-global",
      id: "000",
      name: "global",
      isGlobal: true,
      commands: ["principles"],
    },
    {
      dir: "001-x",
      id: "001",
      name: "x",
      isGlobal: false,
      commands: ["plan", "stakeholders", "risk"],
    },
  ]);
  const p = gaps.projects.find((x) => x.dir === "001-x");
  assert(p);
  assertEquals(p.nextOnCriticalPath, "sobc");
  assertEquals(p.criticalPathDone, 4); // plan, principles(global), stakeholders, risk
  assertEquals(p.criticalPathTotal, CRITICAL_PATH.length);
});

Deno.test("clean project has no violations and full-path progress counted", () => {
  const gaps = computeGaps([
    {
      dir: "001-x",
      id: "001",
      name: "x",
      isGlobal: false,
      commands: ["principles", "stakeholders", "risk", "sobc", "requirements"],
    },
  ]);
  const p = gaps.projects[0];
  assertEquals(p.violations, []);
  assertEquals(p.nextOnCriticalPath, "plan");
});

Deno.test("summary counts projects with violations", () => {
  const gaps = computeGaps([
    { dir: "001-a", id: "001", name: "a", isGlobal: false, commands: ["risk"] },
    { dir: "002-b", id: "002", name: "b", isGlobal: false, commands: ["plan"] },
  ]);
  assertEquals(gaps.summary.projectCount, 2);
  assertEquals(gaps.summary.projectsWithViolations, 1);
  assertEquals(gaps.summary.totalViolations, 1);
});

// ---------- state machine -----------------------------------------------------

Deno.test("slugify produces clean kebab dirs", () => {
  assertEquals(slugify("NHS Appointment Booking!"), "nhs-appointment-booking");
  assertEquals(slugify("  Payments  --  Gateway "), "payments-gateway");
  assertEquals(slugify("###"), "project");
});

Deno.test("nextProjectDir allocates past the highest NNN", () => {
  assertEquals(
    nextProjectDir(["000-global", "001-a", "003-c", "junk"], "new"),
    "004-new",
  );
  assertEquals(nextProjectDir([], "first"), "001-first");
});

Deno.test("phase order walks to complete", () => {
  assertEquals(PHASES[0], "foundation");
  assertEquals(nextPhase("foundation"), "context");
  assertEquals(nextPhase("story"), "complete");
  assertEquals(nextPhase("bogus"), "complete");
});

Deno.test("every phase has a gate and every gate command is producible", () => {
  const producible = new Set(Object.values(DOC_CODES));
  for (const phase of PHASES) {
    const gate = PHASE_GATES[phase];
    assert(gate, `phase ${phase} missing gate`);
    for (const group of gate.groups) {
      for (const cmd of group) {
        assert(producible.has(cmd), `${phase}: ${cmd} unproducible`);
      }
    }
  }
});

Deno.test("uk-gov profile adds tcop and secure to assurance", () => {
  const groups = gateFor("assurance", "uk-gov");
  assertEquals(groups, [["analyze"], ["tcop"], ["secure"]]);
  const r = evaluateGate(["analyze", "tcop"], "assurance", "uk-gov");
  assertEquals(r.satisfied, false);
  assertEquals(r.groups.filter((g) => !g.satisfied).map((g) => g.anyOf), [[
    "secure",
  ]]);
  assert(
    evaluateGate(["analyze", "tcop", "secure"], "assurance", "uk-gov")
      .satisfied,
  );
});

Deno.test("design gate is one-of and ai profile also requires data-model", () => {
  assert(evaluateGate(["wardley"], "design", "standard").satisfied);
  assertEquals(evaluateGate(["wardley"], "design", "ai").satisfied, false);
  assert(evaluateGate(["wardley", "data-model"], "design", "ai").satisfied);
});

Deno.test("gate satisfiedBy names the artifact that satisfied the group", () => {
  const r = evaluateGate(["dos"], "procurement", "standard");
  assert(r.satisfied);
  assertEquals(r.groups[0].satisfiedBy, "dos");
});

Deno.test("every phase-gate and profile-extra command has a template", () => {
  const all = new Set(Object.keys(TEMPLATE_MAP));
  for (const gate of Object.values(PHASE_GATES)) {
    for (const group of gate.groups) {
      for (const cmd of group) assert(all.has(cmd), `no template for ${cmd}`);
    }
  }
  for (
    const extras of Object.values({
      "uk-gov": { a: [["tcop"], ["secure"]] },
    })
  ) {
    for (const groups of Object.values(extras)) {
      for (const group of groups) {
        for (const cmd of group) assert(all.has(cmd), `no template for ${cmd}`);
      }
    }
  }
});

Deno.test("COMMAND_TO_CODE inverts DOC_CODES", () => {
  assertEquals(COMMAND_TO_CODE["requirements"], "REQ");
  assertEquals(COMMAND_TO_CODE["principles-compliance"], "PRIN-COMP");
  assertEquals(COMMAND_TO_CODE["wardley.climate"], "WCLM");
});

Deno.test("every TEMPLATE_MAP file exists in the bundled templates dir", async () => {
  const dir = new URL("../../templates/", import.meta.url).pathname;
  for (const file of Object.values(TEMPLATE_MAP)) {
    const stat = await Deno.stat(`${dir}${file}`);
    assert(stat.isFile && stat.size > 0, `${file} missing or empty`);
  }
});

// ---------- classification migration -------------------------------------------

Deno.test("proposeClassification maps the UK ladder to UAE Smart Data", () => {
  const doc = [
    "| **Version** | 1.0 |",
    "| **Classification** | OFFICIAL |",
    "| **Classification** | OFFICIAL-SENSITIVE |",
    "| **Classification** | PUBLIC |",
    "body text | **Classification** | OFFICIAL | not a table row start",
  ].join("\n");
  const { newText, changes } = proposeClassification(doc);
  assertEquals(changes, [
    { from: "OFFICIAL", to: "Shared" },
    { from: "OFFICIAL-SENSITIVE", to: "Confidential" },
    { from: "PUBLIC", to: "Open" },
  ]);
  assert(newText.includes("| **Classification** | Shared |"));
  assert(newText.includes("| **Classification** | Confidential |"));
  assert(newText.includes("| **Classification** | Open |"));
  // non-row-start line untouched
  assert(newText.includes("body text | **Classification** | OFFICIAL |"));
});

Deno.test("proposeClassification leaves SECRET name unchanged", () => {
  const { changes } = proposeClassification("| **Classification** | SECRET |");
  assertEquals(changes, [{ from: "SECRET", to: "Secret" }]);
});

// ---------- reference-table sanity --------------------------------------------

Deno.test("every mandatory dep is a command some doc code can produce", () => {
  const producible = new Set(Object.values(DOC_CODES));
  for (const [cmd, deps] of Object.entries(MANDATORY_DEPS)) {
    assert(producible.has(cmd), `dep source ${cmd} has no doc code`);
    for (const d of deps) {
      assert(producible.has(d), `${cmd} depends on unproducible ${d}`);
    }
  }
});

Deno.test("critical path steps are all producible commands", () => {
  const producible = new Set(Object.values(DOC_CODES));
  for (const step of CRITICAL_PATH) {
    assert(producible.has(step), `critical path step ${step} unproducible`);
  }
});
