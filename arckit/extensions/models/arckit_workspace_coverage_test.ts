/**
 * Coverage suite: branch fill for `@magistr/arckit/workspace` — profile
 * extras, skippable/non-skippable phase table, terminal states, the
 * templates/provisionTemplates split, migrateClassification's genuine no-op
 * path, and a handful of pure-function-level reinforcements of the
 * `arckit-latent-bugs` LB4/LB5/LB6 fixes whose primary method-level
 * characterization lives in `arckit_workspace_adversarial_test.ts`.
 * `arckit_workspace.ts` is no longer byte-frozen (LB1..LB7 all fixed); tests
 * here now assert the POST-fix behavior for LB4/LB5/LB6, and continue to pin
 * everything else that was never a latent bug.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  evaluateGate,
  gateFor,
  model,
  nextProjectDir,
  parseProjectDir,
  PHASE_GATES,
  PHASES,
  TEMPLATE_MAP,
} from "./arckit_workspace.ts";
import {
  arcFilename,
  docControlContent,
  makeCtx,
  run,
  withTempWorkspace,
  writeArtifact,
  writeTemplateFile,
} from "./fixtures/workspace.ts";

// ---------------------------------------------------------------------------
// Profile extras — uk-gov / mod / ai gate additions, through status()/advance()
// ---------------------------------------------------------------------------

Deno.test("coverage: uk-gov profile's assurance gate additionally requires tcop AND secure, both surfaced by status()", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", {
      title: "x",
      profile: "uk-gov",
      dir: "001-x",
    }, ctx);
    await ctx.writeResource("projectState", "001-x", {
      ...(written[0].payload),
      state: "assurance",
    });
    await writeArtifact(root, "001-x", arcFilename("001", "ANAL"));
    await run(model, "status", { project: "001-x" }, ctx);
    let status = written[written.length - 1].payload;
    assertEquals(status.gateSatisfied, false);
    let groups = status.gate as Array<Record<string, unknown>>;
    assertEquals(groups.map((g) => g.satisfied), [true, false, false]);

    await writeArtifact(root, "001-x", arcFilename("001", "TCOP"));
    await writeArtifact(root, "001-x", arcFilename("001", "SECD"));
    await run(model, "status", { project: "001-x" }, ctx);
    status = written[written.length - 1].payload;
    assertEquals(status.gateSatisfied, true);
    groups = status.gate as Array<Record<string, unknown>>;
    assertEquals(groups.map((g) => g.satisfied), [true, true, true]);
  });
});

Deno.test("coverage: mod profile's assurance gate additionally requires mod-secure", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", {
      title: "x",
      profile: "mod",
      dir: "001-x",
    }, ctx);
    await ctx.writeResource("projectState", "001-x", {
      ...(written[0].payload),
      state: "assurance",
    });
    await writeArtifact(root, "001-x", arcFilename("001", "ANAL"));
    await run(model, "status", { project: "001-x" }, ctx);
    assertEquals(written[written.length - 1].payload.gateSatisfied, false);

    await writeArtifact(root, "001-x", arcFilename("001", "SECD-MOD"));
    await run(model, "status", { project: "001-x" }, ctx);
    assertEquals(written[written.length - 1].payload.gateSatisfied, true);
  });
});

Deno.test("coverage: ai profile adds data-model to BOTH design and assurance (ai-playbook + atrs)", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", {
      title: "x",
      profile: "ai",
      dir: "001-x",
    }, ctx);
    await ctx.writeResource("projectState", "001-x", {
      ...(written[0].payload),
      state: "design",
    });
    await writeArtifact(root, "001-x", arcFilename("001", "WARD"));
    await run(model, "status", { project: "001-x" }, ctx); // design: wardley present, data-model missing
    assertEquals(written[written.length - 1].payload.gateSatisfied, false);

    await writeArtifact(root, "001-x", arcFilename("001", "DATA"));
    await run(model, "status", { project: "001-x" }, ctx);
    assertEquals(written[written.length - 1].payload.gateSatisfied, true);

    await ctx.writeResource("projectState", "001-x", {
      ...(written[0].payload),
      state: "assurance",
    });
    await writeArtifact(root, "001-x", arcFilename("001", "ANAL"));
    await run(model, "status", { project: "001-x" }, ctx); // assurance: analyze present, ai-playbook+atrs missing
    assertEquals(written[written.length - 1].payload.gateSatisfied, false);
    await writeArtifact(root, "001-x", arcFilename("001", "AIPB"));
    await writeArtifact(root, "001-x", arcFilename("001", "ATRS"));
    await run(model, "status", { project: "001-x" }, ctx);
    assertEquals(written[written.length - 1].payload.gateSatisfied, true);
  });
});

Deno.test("coverage: standard profile adds NOTHING beyond the base gate at any phase", () => {
  for (const phase of PHASES) {
    assertEquals(gateFor(phase, "standard"), PHASE_GATES[phase].groups);
  }
});

// ---------------------------------------------------------------------------
// Skippable / non-skippable phase table — full sweep via skipPhase()
// ---------------------------------------------------------------------------

const SKIPPABLE = [
  "business-case",
  "procurement",
  "design-review",
  "delivery",
  "operations",
  "story",
];
const NON_SKIPPABLE = [
  "foundation",
  "context",
  "risk",
  "requirements",
  "design",
  "assurance",
];

Deno.test("coverage: every skippable phase can actually be skipped by skipPhase()", async () => {
  for (const phase of SKIPPABLE) {
    await withTempWorkspace(async (root, templatesDir) => {
      const { ctx, written } = makeCtx(root, templatesDir);
      const at = new Date().toISOString();
      await ctx.writeResource("projectState", "001-x", {
        projectDir: "001-x",
        id: "001",
        title: "x",
        profile: "standard",
        state: phase,
        skipped: [],
        history: [],
        createdAt: at,
        updatedAt: at,
      });
      await run(model, "skipPhase", { project: "001-x", reason: "n/a" }, ctx);
      const s = written[written.length - 1].payload;
      const skipped = s.skipped as Array<Record<string, unknown>>;
      assertEquals(skipped[skipped.length - 1].phase, phase);
    });
  }
});

Deno.test("coverage: every non-skippable phase refuses skipPhase()", async () => {
  for (const phase of NON_SKIPPABLE) {
    await withTempWorkspace(async (root, templatesDir) => {
      const { ctx } = makeCtx(root, templatesDir);
      const at = new Date().toISOString();
      await ctx.writeResource("projectState", "001-x", {
        projectDir: "001-x",
        id: "001",
        title: "x",
        profile: "standard",
        state: phase,
        skipped: [],
        history: [],
        createdAt: at,
        updatedAt: at,
      });
      await assertRejects(
        () => run(model, "skipPhase", { project: "001-x", reason: "n/a" }, ctx),
        Error,
        "not skippable",
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Terminal states — status()'s `terminal` short-circuit
// ---------------------------------------------------------------------------

Deno.test("coverage: status() on a complete project reports gateSatisfied=true, an empty gate, and no nextAction — the terminal short-circuit, not an evaluated empty gate", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    // status() calls presentCommands()/scanWorkspace() UNCONDITIONALLY, even
    // for a terminal state — projects/ must exist before the terminal
    // short-circuit is ever reached.
    await Deno.mkdir(`${root}/projects/001-x`, { recursive: true });
    const { ctx, written } = makeCtx(root, templatesDir);
    const at = new Date().toISOString();
    await ctx.writeResource("projectState", "001-x", {
      projectDir: "001-x",
      id: "001",
      title: "x",
      profile: "standard",
      state: "complete",
      skipped: [],
      history: [],
      createdAt: at,
      updatedAt: at,
    });
    await run(model, "status", { project: "001-x" }, ctx);
    const s = written[written.length - 1].payload;
    assertEquals(s.gate, []);
    assertEquals(s.gateSatisfied, true);
    assertEquals(s.nextAction, undefined);
    assertEquals(s.phaseIndex, PHASES.length); // PHASES.indexOf("complete") === -1
  });
});

Deno.test("coverage: abandon() is allowed to re-target a project that already reached complete/abandoned; startProject IS allowed to restart an abandoned project", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-x" }, ctx);
    await run(
      model,
      "abandon",
      { project: "001-x", reason: "first attempt" },
      ctx,
    );
    // Restarting an ABANDONED project is explicitly allowed (only a
    // non-abandoned prior state is refused).
    await run(model, "startProject", { title: "x take 2", dir: "001-x" }, ctx);
    const restarted = written[written.length - 1].payload;
    assertEquals(restarted.state, "foundation");
    assertEquals(restarted.title, "x take 2");
  });
});

// ---------------------------------------------------------------------------
// templates / provisionTemplates split
// ---------------------------------------------------------------------------

Deno.test("coverage: templates() reports docCode even for a command whose bundled file is missing (sizeBytes 0, docCode still populated)", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "templates", {}, ctx);
    const templates = written[0].payload.templates as Array<
      Record<string, unknown>
    >;
    const risk = templates.find((t) => t.command === "risk")!;
    assertEquals(risk.sizeBytes, 0);
    assertEquals(risk.docCode, "RISK"); // docCode lookup never depends on file presence
  });
});

Deno.test("coverage: provisionTemplates() overwrites an existing target file — 'refreshing defaults' means the second run wins, not a merge", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeTemplateFile(templatesDir, "adr-template.md", "# v1\n");
    const { ctx: ctx1 } = makeCtx(root, templatesDir);
    await run(model, "provisionTemplates", {}, ctx1);
    assertEquals(
      await Deno.readTextFile(`${root}/.arckit/templates/adr-template.md`),
      "# v1\n",
    );

    await writeTemplateFile(templatesDir, "adr-template.md", "# v2\n");
    const { ctx: ctx2 } = makeCtx(root, templatesDir);
    await run(model, "provisionTemplates", {}, ctx2);
    assertEquals(
      await Deno.readTextFile(`${root}/.arckit/templates/adr-template.md`),
      "# v2\n",
    );
  });
});

// ---------------------------------------------------------------------------
// migrateClassification — the genuine no-op path (regex simply doesn't
// match, as opposed to "matched, apply=false", which is report-only)
// ---------------------------------------------------------------------------

Deno.test("coverage: migrateClassification finds zero changes for a Classification value outside the recognized ladder — the regex doesn't match at all", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "REQ"),
      docControlContent("INTERNAL"), // not one of the 5 recognized values
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", { apply: true }, ctx);
    assertEquals(written[0].payload.totalChanges, 0);
    assertEquals(written[0].payload.files, []);
    assertEquals(written[0].payload.scannedFiles, 1); // still scanned — .md and ARC-shaped
    const onDisk = await Deno.readTextFile(
      `${root}/projects/001-x/${arcFilename("001", "REQ")}`,
    );
    assert(onDisk.includes("INTERNAL")); // untouched
  });
});

// ---------------------------------------------------------------------------
// gaps() — 000-global satisfies dependencies workspace-wide, through the
// actual method (the contract-fixture only exercises computeGaps() directly)
// ---------------------------------------------------------------------------

Deno.test("coverage: gaps() via the actual method — 000-global's principles satisfies every other project's dependency on it", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeArtifact(root, "000-global", arcFilename("000", "PRIN"));
    await writeArtifact(root, "001-x", arcFilename("001", "ANAL")); // analyze needs principles
    await writeArtifact(root, "002-y", arcFilename("002", "STRAT")); // strategy needs principles+stakeholders
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "gaps", {}, ctx);
    const projects = written[0].payload.projects as Array<
      Record<string, unknown>
    >;
    const x = projects.find((p) => p.dir === "001-x")!;
    assertEquals(x.violations, []); // principles satisfied globally
    const y = projects.find((p) => p.dir === "002-y")!;
    assertEquals(y.violations, [{
      command: "strategy",
      missingMandatory: ["stakeholders"], // principles satisfied globally, stakeholders is not
    }]);
  });
});

// ---------------------------------------------------------------------------
// otherMarkdownCount — mixed junk alongside real artifacts, through scan()
// ---------------------------------------------------------------------------

Deno.test("coverage: scan() counts multiple stray .md files as otherMarkdownCount while non-.md junk contributes nothing", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeArtifact(root, "001-x", "README.md");
    await writeArtifact(root, "001-x", "NOTES.md");
    await writeArtifact(root, "001-x", "scratch.txt");
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "scan", {}, ctx);
    const projects = written[0].payload.projects as Array<
      Record<string, unknown>
    >;
    const p = projects.find((x) => x.dir === "001-x")!;
    assertEquals(p.artifactCount, 0);
    assertEquals(p.otherMarkdownCount, 2);
  });
});

// ---------------------------------------------------------------------------
// Multi-instance artifacts — through scan(), not just the pure parser
// ---------------------------------------------------------------------------

Deno.test("coverage: scan() keeps multiple instances of the same doc code as separate artifacts, each with its own instance number", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "DFD", "1.0", "md", 2),
    );
    await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "DFD", "1.0", "md", 3),
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "scan", {}, ctx);
    const projects = written[0].payload.projects as Array<
      Record<string, unknown>
    >;
    const p = projects.find((x) => x.dir === "001-x")!;
    assertEquals(p.artifactCount, 2);
    const artifacts = (p.artifacts as Array<Record<string, unknown>>)
      .sort((a, b) => (a.instance as number) - (b.instance as number));
    assertEquals(artifacts.map((a) => a.instance), [2, 3]);
    assertEquals(artifacts.map((a) => a.command), ["dfd", "dfd"]);
  });
});

// ---------------------------------------------------------------------------
// scan() unmappedDocTypes — an unrecognized doc code surfaces at the
// WORKSPACE level (not just the pure parser, which career_kb-style contract
// fixture already pins for parseArtifactFilename in isolation)
// ---------------------------------------------------------------------------

Deno.test("coverage: scan() surfaces an unrecognized doc code in workspace-level unmappedDocTypes", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeArtifact(root, "001-x", arcFilename("001", "ZZZZ"));
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "scan", {}, ctx);
    assertEquals(written[0].payload.unmappedDocTypes, ["ZZZZ"]);
  });
});

// ---------------------------------------------------------------------------
// LB4 fixed: gateFor stays defensively permissive but ProjectStateSchema now
// prevents any bogus state from ever reaching it — gateFor/evaluateGate are
// unchanged pure functions (they still accept any raw string), the schema
// enum makes them simply unreachable from the public API. See the
// method-level fix-regression tests in arckit_workspace_adversarial_test.ts
// for the enum rejection itself.
// ---------------------------------------------------------------------------

Deno.test("coverage (LB4 fixed): gateFor returns an empty group list for any phase name outside PHASES, for every profile — unchanged pure-function behavior, now unreachable via projectState.state", () => {
  for (const profile of ["standard", "uk-gov", "mod", "ai"] as const) {
    assertEquals(gateFor("totally-bogus-phase", profile), []);
    assertEquals(evaluateGate(["anything"], "totally-bogus-phase", profile), {
      satisfied: true,
      groups: [],
    });
  }
});

// ---------------------------------------------------------------------------
// LB5 fixed: project-id allocation no longer breaks past 999 —
// nextProjectDir's zero-padding stays 3-digit for ids <=999; parseProjectDir
// (`\d{3,}`) now accepts the 4+ digit ids padStart naturally produces past
// the boundary instead of rejecting them.
// ---------------------------------------------------------------------------

Deno.test("coverage (LB5 fixed): nextProjectDir at the 999 boundary yields a 4-digit id that parseProjectDir now ACCEPTS", () => {
  assertEquals(nextProjectDir(["999-last"], "new"), "1000-new");
  const parsed = parseProjectDir("1000-new");
  assert(parsed);
  assertEquals(parsed, { id: "1000", name: "new", isGlobal: false });
  // one below the boundary still round-trips cleanly, unchanged
  assertEquals(nextProjectDir(["998-last"], "new"), "999-new");
  const p = parseProjectDir("999-new");
  assert(p);
  assertEquals(p.id, "999");
});

// ---------------------------------------------------------------------------
// LB6 reconciled: the TEMPLATE_MAP command set is exactly what templates()
// enumerates as commands, independent of what's physically bundled — but
// every bundled orphan now additionally surfaces in unmappedFiles[].
// ---------------------------------------------------------------------------

Deno.test("coverage (LB6 reconciled): templates() always enumerates exactly Object.keys(TEMPLATE_MAP).length command entries regardless of extra bundled files present, and the extra bundled orphans now show up in unmappedFiles", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeTemplateFile(templatesDir, "tech-note-template.md"); // orphan #2
    await writeTemplateFile(templatesDir, "vendor-scoring-template.md"); // orphan #3
    await writeTemplateFile(templatesDir, "data-source-profile-template.md"); // orphan #4
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "templates", {}, ctx);
    assertEquals(
      written[0].payload.templateCount,
      Object.keys(TEMPLATE_MAP).length,
    );
    assertEquals(written[0].payload.unmappedFiles, [
      "data-source-profile-template.md",
      "tech-note-template.md",
      "vendor-scoring-template.md",
    ]);
  });
});
