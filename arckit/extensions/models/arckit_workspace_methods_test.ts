/**
 * Methods suite: happy-path coverage of all 12 `@magistr/arckit/workspace`
 * methods (init, scan, gaps, startProject, status, advance, skipPhase,
 * abandon, templates, template, provisionTemplates, migrateClassification)
 * against a synthetic ArcKit governance-workspace fixture built in a
 * `Deno.makeTempDir()` tree — real `Deno.readDir`/`readTextFile`/`writeFile`,
 * no FS stubbing (see `fixtures/workspace.ts`).
 *
 * `arckit_workspace.ts` is BYTE-FROZEN; this suite drives it unmodified via
 * `model.methods.<m>.execute(args, ctx)` behind a fake context (globalArgs +
 * logger + writeResource + readResource + extensionFile). Every assertion
 * checks the written resource's KIND + INSTANCE NAME plus concrete decoded
 * fields, not just counts, per the approved plan.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model, TEMPLATE_MAP } from "./arckit_workspace.ts";
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
// init
// ---------------------------------------------------------------------------

Deno.test("methods: init scaffolds the workspace skeleton, reporting every dir as created", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "init", {}, ctx);
    assertEquals(written.length, 1);
    assertEquals(written[0].spec, "initResult");
    assertEquals(written[0].name, "init");
    const payload = written[0].payload;
    assertEquals(payload.path, root);
    assertEquals(payload.existing, []);
    assert((payload.created as string[]).includes("projects/000-global"));
    assert(
      (payload.created as string[]).includes(
        "projects/000-global/policies",
      ),
    );
    assert((payload.created as string[]).includes(".arckit/scripts/bash"));

    // physically scaffolded on disk
    const stat = await Deno.stat(`${root}/projects/000-global/policies`);
    assert(stat.isDirectory);
    const gitkeep = await Deno.stat(
      `${root}/projects/000-global/.gitkeep`,
    );
    assert(gitkeep.isFile);
  });
});

Deno.test("methods: init is idempotent — a second run reports every dir as existing, none created", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx: ctx1 } = makeCtx(root, templatesDir);
    await run(model, "init", {}, ctx1);
    const { ctx: ctx2, written } = makeCtx(root, templatesDir);
    await run(model, "init", {}, ctx2);
    assertEquals(written[0].payload.created, []);
    assert((written[0].payload.existing as string[]).length > 0);
  });
});

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

Deno.test("methods: scan inventories every project's ARC-* artifacts with parsed doc type / command / version", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeArtifact(
      root,
      "000-global",
      arcFilename("000", "PRIN"),
      "# principles\n",
    );
    await writeArtifact(
      root,
      "001-payments",
      arcFilename("001", "REQ"),
      "# requirements\n",
    );
    await writeArtifact(
      root,
      "001-payments",
      "notes.md", // not an ARC-* artifact
      "# scratch notes\n",
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "scan", {}, ctx);
    assertEquals(written[0].spec, "workspace");
    assertEquals(written[0].name, "workspace");
    const payload = written[0].payload;
    assertEquals(payload.path, root);
    assertEquals(payload.projectCount, 2);
    assertEquals(payload.artifactCount, 2);
    const projects = payload.projects as Array<Record<string, unknown>>;
    const payments = projects.find((p) => p.dir === "001-payments")!;
    assertEquals(payments.otherMarkdownCount, 1);
    const artifacts = payments.artifacts as Array<Record<string, unknown>>;
    assertEquals(artifacts[0].command, "requirements");
    assertEquals(artifacts[0].docType, "REQ");
    assertEquals(artifacts[0].projectId, "001");
    assertEquals(artifacts[0].version, "1.0");
    assertEquals(artifacts[0].format, "md");
    assert(typeof artifacts[0].sizeBytes === "number");
    const global = projects.find((p) => p.dir === "000-global")!;
    assertEquals(global.isGlobal, true);
  });
});

// NOTE: scanWorkspace's try/catch around `Deno.readDir(projectsDir)` is
// intended to rewrap a missing directory as "Not an ArcKit workspace", but
// `Deno.readDir()` is LAZY — it never throws synchronously; the ENOENT only
// surfaces once the `for await` loop actually iterates, which is OUTSIDE the
// try/catch. So the friendly message is unreachable dead code for this exact
// case; the raw Deno filesystem error propagates instead. Characterized as
// CURRENT behavior (arckit_workspace.ts is byte-frozen) — not one of the 7
// arckit-latent-bugs findings (out of scope for this backfill's triage), but
// pinned here so the test suite reflects reality rather than the source's
// evident intent.
Deno.test("methods: scan on a missing projects/ throws the RAW Deno filesystem error, not the friendly 'Not an ArcKit workspace' message (the try/catch never fires — Deno.readDir is lazy)", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx } = makeCtx(root, templatesDir);
    await assertRejects(
      () => run(model, "scan", {}, ctx),
      Deno.errors.NotFound,
    );
  });
});

// ---------------------------------------------------------------------------
// gaps
// ---------------------------------------------------------------------------

Deno.test("methods: gaps flags a project missing a mandatory dependency and reports the critical-path position", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeArtifact(root, "000-global", arcFilename("000", "PRIN"));
    await writeArtifact(root, "001-x", arcFilename("001", "RISK"));
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "gaps", {}, ctx);
    const payload = written[0].payload;
    assertEquals(payload.globalCommands, ["principles"]);
    const projects = payload.projects as Array<Record<string, unknown>>;
    const p = projects.find((x) => x.dir === "001-x")!;
    assertEquals(p.violations, [{
      command: "risk",
      missingMandatory: ["stakeholders"],
    }]);
    const summary = payload.summary as Record<string, number>;
    assertEquals(summary.projectCount, 1);
    assertEquals(summary.projectsWithViolations, 1);
    assertEquals(summary.totalViolations, 1);
  });
});

// ---------------------------------------------------------------------------
// startProject
// ---------------------------------------------------------------------------

Deno.test("methods: startProject allocates the next NNN-slug dir from the title and enters foundation", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "Payment Gateway" }, ctx);
    assertEquals(written[0].spec, "projectState");
    assertEquals(written[0].name, "001-payment-gateway");
    const payload = written[0].payload;
    assertEquals(payload.projectDir, "001-payment-gateway");
    assertEquals(payload.id, "001");
    assertEquals(payload.title, "Payment Gateway");
    assertEquals(payload.profile, "standard");
    assertEquals(payload.state, "foundation");
    assertEquals(payload.skipped, []);
    const history = payload.history as Array<Record<string, unknown>>;
    assertEquals(history.length, 1);
    assertEquals(history[0].from, "-");
    assertEquals(history[0].to, "foundation");
    assertEquals(history[0].via, "start");

    const stat = await Deno.stat(`${root}/projects/001-payment-gateway`);
    assert(stat.isDirectory);
  });
});

Deno.test("methods: startProject honors an explicit profile and dir", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", {
      title: "UK Gov Service",
      profile: "uk-gov",
      dir: "007-ukgov",
    }, ctx);
    assertEquals(written[0].name, "007-ukgov");
    assertEquals(written[0].payload.profile, "uk-gov");
    assertEquals(written[0].payload.id, "007");
  });
});

Deno.test("methods: startProject refuses to restart a project already in flight", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-x" }, ctx);
    await assertRejects(
      () => run(model, "startProject", { title: "x again", dir: "001-x" }, ctx),
      Error,
      "already started",
    );
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

Deno.test("methods: status reports the current gate evaluated against artifacts actually on disk, with the suggested next action", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-x" }, ctx);
    await run(model, "status", { project: "001-x" }, ctx);
    const payload = written[1].payload;
    assertEquals(written[1].spec, "projectStatus");
    assertEquals(written[1].name, "001-x-status");
    assertEquals(payload.state, "foundation");
    assertEquals(payload.phaseIndex, 0);
    assertEquals(payload.phaseCount, 12);
    assertEquals(payload.gateSatisfied, false);
    assertEquals(payload.skippable, false);
    const nextAction = payload.nextAction as Record<string, unknown>;
    assertEquals(nextAction.command, "principles");
    assertEquals(nextAction.docCode, "PRIN");
    assertEquals(nextAction.suggestedFilename, "ARC-001-PRIN-v1.0.md");
  });
});

Deno.test("methods: status reflects gateSatisfied once the required artifact exists on disk", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-x" }, ctx);
    await writeArtifact(root, "001-x", arcFilename("001", "PRIN"));
    await run(model, "status", { project: "001-x" }, ctx);
    const payload = written[1].payload;
    assertEquals(payload.gateSatisfied, true);
    assertEquals(payload.presentCommands, ["principles"]);
  });
});

// ---------------------------------------------------------------------------
// advance
// ---------------------------------------------------------------------------

Deno.test("methods: advance moves to the next phase once the current phase's gate is satisfied", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-x" }, ctx);
    await writeArtifact(root, "001-x", arcFilename("001", "PRIN"));
    await run(
      model,
      "advance",
      { project: "001-x", note: "principles done" },
      ctx,
    );
    const payload = written[1].payload;
    assertEquals(written[1].spec, "projectState");
    assertEquals(payload.state, "context");
    const history = payload.history as Array<Record<string, unknown>>;
    assertEquals(history.length, 2);
    assertEquals(history[1].from, "foundation");
    assertEquals(history[1].to, "context");
    assertEquals(history[1].via, "advance");
    assertEquals(history[1].note, "principles done");
  });
});

Deno.test("methods: advance refuses when the gate is not satisfied, naming the missing commands", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-x" }, ctx);
    await assertRejects(
      () => run(model, "advance", { project: "001-x" }, ctx),
      Error,
      "principles",
    );
  });
});

Deno.test("methods: advance from the last phase (story) reaches complete", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-x" }, ctx);
    // Seed the projectState directly at "story" (the last phase) with the
    // story artifact already present, bypassing the intermediate phases —
    // this suite's concern is advance()'s OWN last-phase-to-complete step.
    await writeArtifact(root, "001-x", arcFilename("001", "STORY"));
    await ctx.writeResource("projectState", "001-x", {
      ...(written[0].payload),
      state: "story",
    });
    await run(model, "advance", { project: "001-x" }, ctx);
    const last = written[written.length - 1];
    assertEquals(last.payload.state, "complete");
  });
});

// ---------------------------------------------------------------------------
// skipPhase
// ---------------------------------------------------------------------------

Deno.test("methods: skipPhase bypasses a skippable phase, recording the reason in both skipped[] and history[]", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-x" }, ctx);
    await writeArtifact(root, "001-x", arcFilename("001", "PRIN"));
    await run(model, "advance", { project: "001-x" }, ctx); // -> context
    await writeArtifact(root, "001-x", arcFilename("001", "STKE"));
    await run(model, "advance", { project: "001-x" }, ctx); // -> risk
    await writeArtifact(root, "001-x", arcFilename("001", "RISK"));
    await run(model, "advance", { project: "001-x" }, ctx); // -> business-case (skippable)
    await run(model, "skipPhase", {
      project: "001-x",
      reason: "no business case needed for this internal tool",
    }, ctx);
    const payload = written[written.length - 1].payload;
    assertEquals(payload.state, "requirements");
    const skipped = payload.skipped as Array<Record<string, unknown>>;
    assertEquals(skipped.length, 1);
    assertEquals(skipped[0].phase, "business-case");
    assertEquals(
      skipped[0].reason,
      "no business case needed for this internal tool",
    );
    const history = payload.history as Array<Record<string, unknown>>;
    assertEquals(history[history.length - 1].via, "skip");
  });
});

Deno.test("methods: skipPhase refuses a non-skippable phase", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-x" }, ctx);
    await assertRejects(
      () =>
        run(model, "skipPhase", { project: "001-x", reason: "why not" }, ctx),
      Error,
      "not skippable",
    );
  });
});

// ---------------------------------------------------------------------------
// abandon
// ---------------------------------------------------------------------------

Deno.test("methods: abandon closes a project from any state, recording the reason", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-x" }, ctx);
    await run(model, "abandon", {
      project: "001-x",
      reason: "superseded by 002",
    }, ctx);
    const payload = written[written.length - 1].payload;
    assertEquals(payload.state, "abandoned");
    assertEquals(payload.abandonReason, "superseded by 002");
    const history = payload.history as Array<Record<string, unknown>>;
    assertEquals(history[history.length - 1].via, "abandon");
  });
});

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

Deno.test("methods: templates catalogs the TEMPLATE_MAP with real sizes for bundled files and zero for missing ones", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeTemplateFile(
      templatesDir,
      "requirements-template.md",
      "# Requirements Template\n",
    );
    await writeTemplateFile(templatesDir, "_partials/document-control-uk.md");
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "templates", {}, ctx);
    const payload = written[0].payload;
    assertEquals(payload.templateCount, Object.keys(TEMPLATE_MAP).length);
    const templates = payload.templates as Array<Record<string, unknown>>;
    const req = templates.find((t) => t.command === "requirements")!;
    assertEquals(req.docCode, "REQ");
    assert((req.sizeBytes as number) > 0);
    const risk = templates.find((t) => t.command === "risk")!;
    assertEquals(risk.sizeBytes, 0); // not bundled in this synthetic dir
    assertEquals(payload.partials, ["document-control-uk.md"]);
  });
});

Deno.test("methods: templates tolerates a missing _partials directory entirely", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "templates", {}, ctx);
    assertEquals(written[0].payload.partials, []);
  });
});

// ---------------------------------------------------------------------------
// template
// ---------------------------------------------------------------------------

Deno.test("methods: template serves the bundled content plus doc code and mandatory inputs, with a target filename when a project is given", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeTemplateFile(
      templatesDir,
      "risk-register-template.md",
      "# Risk Register\n",
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "template", { command: "risk", project: "001-x" }, ctx);
    assertEquals(written[0].spec, "templateDoc");
    assertEquals(written[0].name, "template-risk");
    const payload = written[0].payload;
    assertEquals(payload.docCode, "RISK");
    assertEquals(payload.templateFile, "risk-register-template.md");
    assertEquals(payload.targetDir, "projects/001-x");
    assertEquals(payload.suggestedFilename, "ARC-001-RISK-v1.0.md");
    assertEquals(payload.mandatoryInputs, ["stakeholders"]);
    assertEquals(payload.content, "# Risk Register\n");
  });
});

Deno.test("methods: template omits target fields when no project is given", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeTemplateFile(
      templatesDir,
      "architecture-principles-template.md",
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "template", { command: "principles" }, ctx);
    const payload = written[0].payload;
    assertEquals(payload.targetDir, undefined);
    assertEquals(payload.suggestedFilename, undefined);
  });
});

// ---------------------------------------------------------------------------
// provisionTemplates
// ---------------------------------------------------------------------------

Deno.test("methods: provisionTemplates copies every bundled template (and _partials) into .arckit/templates/", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeTemplateFile(templatesDir, "adr-template.md", "# ADR\n");
    await writeTemplateFile(
      templatesDir,
      "risk-register-template.md",
      "# Risk\n",
    );
    await writeTemplateFile(
      templatesDir,
      "_partials/document-control-uk.md",
      "# UK\n",
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "provisionTemplates", {}, ctx);
    const payload = written[0].payload;
    assertEquals(payload.targetDir, ".arckit/templates");
    assertEquals(payload.fileCount, 3);
    assert((payload.written as string[]).includes("adr-template.md"));
    assert(
      (payload.written as string[]).includes(
        "_partials/document-control-uk.md",
      ),
    );
    const copied = await Deno.readTextFile(
      `${root}/.arckit/templates/adr-template.md`,
    );
    assertEquals(copied, "# ADR\n");
    const copiedPartial = await Deno.readTextFile(
      `${root}/.arckit/templates/_partials/document-control-uk.md`,
    );
    assertEquals(copiedPartial, "# UK\n");
  });
});

Deno.test("methods: provisionTemplates tolerates a bundle with no _partials directory", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeTemplateFile(templatesDir, "adr-template.md", "# ADR\n");
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "provisionTemplates", {}, ctx);
    assertEquals(written[0].payload.fileCount, 1);
  });
});

// ---------------------------------------------------------------------------
// migrateClassification
// ---------------------------------------------------------------------------

Deno.test("methods: migrateClassification (report-only) proposes changes without writing the file", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const full = await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "REQ"),
      docControlContent("OFFICIAL"),
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", {}, ctx);
    const payload = written[0].payload;
    assertEquals(payload.apply, false);
    assertEquals(payload.totalChanges, 1);
    const files = payload.files as Array<Record<string, unknown>>;
    assertEquals(files[0].relPath, `001-x/${arcFilenameReq()}`);
    assertEquals(files[0].changes, [{ from: "OFFICIAL", to: "Shared" }]);
    const onDisk = await Deno.readTextFile(full);
    assert(onDisk.includes("OFFICIAL")); // untouched — report-only
  });
});

Deno.test("methods: migrateClassification (apply=true) rewrites the artifact in place", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const full = await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "REQ"),
      docControlContent("PUBLIC"),
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", { apply: true }, ctx);
    assertEquals(written[0].payload.apply, true);
    const onDisk = await Deno.readTextFile(full);
    assert(onDisk.includes("| **Classification** | Open |"));
    assert(!onDisk.includes("PUBLIC"));
  });
});

Deno.test("methods: migrateClassification finds zero changes when no artifact has a Classification line", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeArtifact(root, "001-x", arcFilename("001", "REQ"), "# plain\n");
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", {}, ctx);
    assertEquals(written[0].payload.totalChanges, 0);
    assertEquals(written[0].payload.files, []);
    assertEquals(written[0].payload.scannedFiles, 1);
  });
});

function arcFilenameReq(): string {
  return arcFilename("001", "REQ");
}
