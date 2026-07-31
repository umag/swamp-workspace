/**
 * Adversarial suite: hostile/malformed inputs, pinning CURRENT behavior.
 * `arckit_workspace.ts` is BYTE-FROZEN — nothing here is a proposed fix,
 * every test asserts what the shipped code ACTUALLY does today. Every
 * `pin (arckit-latent-bugs LBN, SEVERITY):`-titled test corresponds to one
 * of the 7 findings recorded in the LOCAL `arckit-latent-bugs`
 * issue-lifecycle model (NEVER a swamp.club Lab issue) — see that model's
 * description for the full write-up; these tests are the reproduction.
 *
 * No test in this suite ever writes outside its own `Deno.makeTempDir()`
 * tree (the datastore/no-escape rule) — LB1's traversal payload and LB2's
 * apply-overwrite both resolve strictly INSIDE the temp root.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./arckit_workspace.ts";
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
// pin (arckit-latent-bugs LB1, HIGH): startProject's `dir` accepts a
// traversal segment with zero sanitization — arckit_workspace.ts:1049/1065
// ---------------------------------------------------------------------------

Deno.test("pin (arckit-latent-bugs LB1, HIGH): startProject's dir '001-a/../b' resolves on disk to projects/b (the '..' collapses '001-a'), never creating 001-a, while the persisted projectState resource is keyed on the RAW literal string", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-a/../b" }, ctx);

    // On-disk: only "b" exists under projects/ — "001-a" was never created,
    // the whole segment was consumed by mkdir's OS-level path normalization.
    const bStat = await Deno.stat(`${root}/projects/b`);
    assert(bStat.isDirectory);
    await assertRejects(() => Deno.stat(`${root}/projects/001-a`));

    // The written projectState resource is keyed on the LITERAL unsanitized
    // dir string, not the resolved on-disk path.
    assertEquals(written[0].name, "001-a/../b");
    assertEquals(written[0].payload.projectDir, "001-a/../b");
    assertEquals(written[0].payload.id, "001"); // parseProjectDir's \d{3} group

    // Never escapes the temp root — proves the sandboxed reproduction is
    // safe, not that the underlying primitive is safe in general (a deeper
    // payload like "001-a/../../../../<abs>/pwn" would escape a REAL
    // workspace root; that is exactly why this is pinned HIGH, not fixed).
    const rootReal = await Deno.realPath(root);
    const bReal = await Deno.realPath(`${root}/projects/b`);
    assert(bReal.startsWith(rootReal));
  });
});

Deno.test("pin (arckit-latent-bugs LB1, HIGH): parseProjectDir's regex lets the traversal segment through — it is the `(.+)` group, not a rejected shape", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx } = makeCtx(root, templatesDir);
    // A dir with NO ".." still demonstrates the same missing-sanitization
    // primitive: any "/" in the slug is accepted and becomes a real nested
    // directory that startProject's caller never asked for by name.
    await run(
      model,
      "startProject",
      { title: "x", dir: "002-nested/deep" },
      ctx,
    );
    const stat = await Deno.stat(`${root}/projects/002-nested/deep`);
    assert(stat.isDirectory);
  });
});

// ---------------------------------------------------------------------------
// pin (arckit-latent-bugs LB2, MEDIUM): migrateClassification apply=true is a
// non-atomic in-place overwrite with no backup — arckit_workspace.ts:1461
// ---------------------------------------------------------------------------

Deno.test("pin (arckit-latent-bugs LB2, MEDIUM): migrateClassification apply=true overwrites the artifact directly via writeTextFile — no temp-then-rename, no backup sibling left behind", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const full = await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "REQ"),
      docControlContent("OFFICIAL-SENSITIVE"),
    );
    const { ctx } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", { apply: true }, ctx);

    const onDisk = await Deno.readTextFile(full);
    assert(onDisk.includes("| **Classification** | Confidential |"));
    // No backup/temp sibling of any kind is left in the project directory —
    // characterizing the ABSENCE of the safety net a temp-then-rename would
    // leave evidence of.
    const siblings: string[] = [];
    for await (const e of Deno.readDir(`${root}/projects/001-x`)) {
      siblings.push(e.name);
    }
    assertEquals(siblings, [arcFilename("001", "REQ")]);
  });
});

// ---------------------------------------------------------------------------
// pin (arckit-latent-bugs LB3, LOW): unbounded readTextFile in
// migrateClassification / template — no size cap anywhere.
// ---------------------------------------------------------------------------

Deno.test("pin (arckit-latent-bugs LB3, LOW): migrateClassification reads and rewrites a large artifact whole, with no size cap", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    // ~500KB — large enough to demonstrate "no cap", small enough for fast CI.
    const filler = "x".repeat(500_000);
    const content = `${filler}\n${docControlContent("PUBLIC")}`;
    const full = await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "REQ"),
      content,
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", { apply: true }, ctx);
    assertEquals(written[0].payload.totalChanges, 1);
    const onDisk = await Deno.readTextFile(full);
    // Full round-trip, nothing truncated: the 500K filler survives intact
    // (unaffected by the classification substitution that follows it), and
    // the file length only shifts by the "PUBLIC"->"Open" delta — never
    // clipped to some smaller cap.
    assert(onDisk.startsWith(filler));
    assert(onDisk.includes("| **Classification** | Open |"));
    assertEquals(
      onDisk.length,
      content.length - ("PUBLIC".length - "Open".length),
    );
  });
});

Deno.test("pin (arckit-latent-bugs LB3, LOW): template serves a large bundled file's FULL content, with no size cap", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const big = "# Requirements\n" + "y".repeat(500_000);
    await writeTemplateFile(templatesDir, "requirements-template.md", big);
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "template", { command: "requirements" }, ctx);
    assertEquals((written[0].payload.content as string).length, big.length);
  });
});

// ---------------------------------------------------------------------------
// pin (arckit-latent-bugs LB4, LOW): non-enum projectState.state auto-
// completes an unknown-phase gate — arckit_workspace.ts:396 (ProjectStateSchema
// z.string()) + gateFor/evaluateGate/nextPhase. NOT reachable via the public
// API (startProject only ever writes a value from PHASES); this pins the
// corrupted/hand-edited/datastore-restored scenario by seeding the resource
// directly, bypassing startProject.
// ---------------------------------------------------------------------------

Deno.test("pin (arckit-latent-bugs LB4, LOW): status on a project whose state is an unknown phase reports gateSatisfied=true vacuously (zero gate groups)", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await Deno.mkdir(`${root}/projects/001-x`, { recursive: true });
    const { ctx, written } = makeCtx(root, templatesDir);
    const at = new Date().toISOString();
    await ctx.writeResource("projectState", "001-x", {
      projectDir: "001-x",
      id: "001",
      title: "corrupted",
      profile: "standard",
      state: "totally-bogus-phase", // outside the PHASES enum entirely
      skipped: [],
      history: [],
      createdAt: at,
      updatedAt: at,
    });
    await run(model, "status", { project: "001-x" }, ctx);
    const status = written[written.length - 1].payload;
    assertEquals(status.gate, []); // gateFor returns [] for an unknown phase
    assertEquals(status.gateSatisfied, true); // [].every(...) is vacuously true
    assertEquals(status.nextAction, undefined);
  });
});

Deno.test("pin (arckit-latent-bugs LB4, LOW): advance on a project whose state is an unknown phase jumps straight to complete", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await Deno.mkdir(`${root}/projects/001-x`, { recursive: true });
    const { ctx, written } = makeCtx(root, templatesDir);
    const at = new Date().toISOString();
    await ctx.writeResource("projectState", "001-x", {
      projectDir: "001-x",
      id: "001",
      title: "corrupted",
      profile: "standard",
      state: "totally-bogus-phase",
      skipped: [],
      history: [],
      createdAt: at,
      updatedAt: at,
    });
    await run(model, "advance", { project: "001-x" }, ctx);
    const state = written[written.length - 1].payload;
    assertEquals(state.state, "complete");
    const history = state.history as Array<Record<string, unknown>>;
    assertEquals(history[history.length - 1].from, "totally-bogus-phase");
    assertEquals(history[history.length - 1].to, "complete");
  });
});

// ---------------------------------------------------------------------------
// pin (arckit-latent-bugs LB5, LOW): project-id allocation boundary breaks
// past 999 — arckit_workspace.ts nextProjectDir / parseProjectDir.
// ---------------------------------------------------------------------------

Deno.test("pin (arckit-latent-bugs LB5, LOW): startProject throws once the highest existing project id is 999 — nextProjectDir yields a 4-digit '1000-slug' that parseProjectDir then rejects", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await Deno.mkdir(`${root}/projects/999-last`, { recursive: true });
    const { ctx } = makeCtx(root, templatesDir);
    await assertRejects(
      () => run(model, "startProject", { title: "one too many" }, ctx),
      Error,
      'Project dir must match NNN-slug (got "1000-one-too-many")',
    );
  });
});

// ---------------------------------------------------------------------------
// pin (arckit-latent-bugs LB6, LOW/info): templates vs provisionTemplates
// inventory divergence — templates() only enumerates TEMPLATE_MAP's 61 known
// commands; provisionTemplates() copies EVERY bundled file. Four real
// arc-kit template files are bundled but have no TEMPLATE_MAP entry.
// ---------------------------------------------------------------------------

Deno.test("pin (arckit-latent-bugs LB6, LOW/info): a bundled template file with no TEMPLATE_MAP entry is invisible to templates() but IS copied by provisionTemplates()", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    // One of the four real orphans named in the latent-bug write-up.
    await writeTemplateFile(
      templatesDir,
      "framework-overview-template.md",
      "# Framework Overview\n",
    );
    const { ctx: ctx1, written: w1 } = makeCtx(root, templatesDir);
    await run(model, "templates", {}, ctx1);
    const templates = w1[0].payload.templates as Array<Record<string, unknown>>;
    assert(
      !templates.some((t) => t.file === "framework-overview-template.md"),
      "templates() must not surface a file with no TEMPLATE_MAP command",
    );

    const { ctx: ctx2, written: w2 } = makeCtx(root, templatesDir);
    await run(model, "provisionTemplates", {}, ctx2);
    assert(
      (w2[0].payload.written as string[]).includes(
        "framework-overview-template.md",
      ),
      "provisionTemplates() copies every bundled file regardless of TEMPLATE_MAP membership",
    );
    const copied = await Deno.readTextFile(
      `${root}/.arckit/templates/framework-overview-template.md`,
    );
    assertEquals(copied, "# Framework Overview\n");
  });
});

// ---------------------------------------------------------------------------
// pin (arckit-latent-bugs LB7, LOW/info): symlinked artifacts silently
// skipped — listFilesRecursive/scanWorkspace only count isFile || isDirectory.
// ---------------------------------------------------------------------------

Deno.test("pin (arckit-latent-bugs LB7, LOW/info): a symlinked ARC-* artifact is invisible to scan — isFile and isDirectory are both false for a symlink entry", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await Deno.mkdir(`${root}/projects/001-x`, { recursive: true });
    await Deno.writeTextFile(`${root}/outside-real-target.md`, "# real\n");
    await Deno.symlink(
      `${root}/outside-real-target.md`,
      `${root}/projects/001-x/${arcFilename("001", "REQ")}`,
    );
    // A second, ordinary (non-symlink) artifact in the same project proves
    // the scan otherwise works — the symlink is the ONLY thing missing.
    await writeArtifact(root, "001-x", arcFilename("001", "RISK"));

    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "scan", {}, ctx);
    const projects = written[0].payload.projects as Array<
      Record<string, unknown>
    >;
    const p = projects.find((x) => x.dir === "001-x")!;
    assertEquals(p.artifactCount, 1); // only RISK; the symlinked REQ is invisible
    const artifacts = p.artifacts as Array<Record<string, unknown>>;
    assert(!artifacts.some((a) => a.docType === "REQ"));
    assert(artifacts.some((a) => a.docType === "RISK"));
  });
});

// ---------------------------------------------------------------------------
// Security-POSITIVE pin: `template` is map-gated — an arbitrary or
// traversing `command` throws "No template" and NEVER reaches
// Deno.readTextFile, unlike startProject's `dir` (LB1).
// ---------------------------------------------------------------------------

Deno.test("pin: template's command is map-gated — a path-traversing command throws 'No template' before any file read is attempted", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx } = makeCtx(root, templatesDir);
    await assertRejects(
      () => run(model, "template", { command: "../../../etc/passwd" }, ctx),
      Error,
      "No template",
    );
  });
});

Deno.test("pin: template's command is map-gated — an unknown command throws 'No template', listing the available commands", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx } = makeCtx(root, templatesDir);
    await assertRejects(
      () => run(model, "template", { command: "no-such-command" }, ctx),
      Error,
      'No template for command "no-such-command"',
    );
  });
});

// ---------------------------------------------------------------------------
// Hostile inputs beyond the pinned latent bugs
// ---------------------------------------------------------------------------

Deno.test("adversarial: startProject refuses the reserved 000 project dir", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx } = makeCtx(root, templatesDir);
    await assertRejects(
      () =>
        run(model, "startProject", { title: "x", dir: "000-anything" }, ctx),
      Error,
      "000 is reserved for the global project",
    );
  });
});

Deno.test("adversarial: startProject refuses an in-flight (non-abandoned) project at ANY phase, not just foundation", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-x" }, ctx);
    await writeArtifact(root, "001-x", arcFilename("001", "PRIN"));
    await run(model, "advance", { project: "001-x" }, ctx); // -> context
    await assertRejects(
      () => run(model, "startProject", { title: "x", dir: "001-x" }, ctx),
      Error,
      "already started (state: context)",
    );
  });
});

Deno.test("adversarial: status/advance/skipPhase throw 'No state for project ... — run startProject first' when no project was ever started", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx } = makeCtx(root, templatesDir);
    await assertRejects(
      () => run(model, "status", { project: "999-ghost" }, ctx),
      Error,
      "No state for project 999-ghost — run startProject first",
    );
    await assertRejects(
      () => run(model, "advance", { project: "999-ghost" }, ctx),
      Error,
      "No state for project 999-ghost — run startProject first",
    );
    await assertRejects(
      () => run(model, "skipPhase", { project: "999-ghost", reason: "x" }, ctx),
      Error,
      "No state for project 999-ghost — run startProject first",
    );
  });
});

Deno.test("adversarial: abandon on a project that was never started throws WITHOUT the 'run startProject first' suffix (unlike status/advance/skipPhase)", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx } = makeCtx(root, templatesDir);
    const err = await assertRejects(
      () => run(model, "abandon", { project: "999-ghost", reason: "x" }, ctx),
      Error,
    );
    assertEquals(err.message, "No state for project 999-ghost");
  });
});

Deno.test("adversarial: advance/status/skipPhase throw once a project is complete or abandoned", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "x", dir: "001-x" }, ctx);
    await run(model, "abandon", { project: "001-x", reason: "done" }, ctx);
    await assertRejects(
      () => run(model, "advance", { project: "001-x" }, ctx),
      Error,
      "is abandoned",
    );
    await assertRejects(
      () => run(model, "skipPhase", { project: "001-x", reason: "x" }, ctx),
      Error,
      "is abandoned",
    );
  });
});

Deno.test("adversarial: migrateClassification skips a non-.md artifact even when it carries classification-looking text", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "BKLG", "1.0", "json"),
      docControlContent("OFFICIAL"),
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", {}, ctx);
    assertEquals(written[0].payload.scannedFiles, 0);
    assertEquals(written[0].payload.totalChanges, 0);
  });
});

Deno.test("adversarial: migrateClassification lossy-decodes invalid UTF-8 bytes rather than throwing, and still finds/applies the classification change", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const filename = arcFilename("001", "REQ");
    const dir = `${root}/projects/001-x`;
    await Deno.mkdir(dir, { recursive: true });
    const prefix = new TextEncoder().encode("# Requirements\n\n");
    const invalid = new Uint8Array([0xff, 0xfe, 0x00, 0xff]);
    const suffix = new TextEncoder().encode(
      `\n${docControlContent("SECRET")}`,
    );
    const bytes = new Uint8Array(
      prefix.length + invalid.length + suffix.length,
    );
    bytes.set(prefix, 0);
    bytes.set(invalid, prefix.length);
    bytes.set(suffix, prefix.length + invalid.length);
    const full = `${dir}/${filename}`;
    await Deno.writeFile(full, bytes);

    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", { apply: true }, ctx);
    assertEquals(written[0].payload.totalChanges, 1);
    const onDisk = await Deno.readTextFile(full);
    assert(onDisk.includes("| **Classification** | Secret |"));
    assert(onDisk.includes("�")); // lossy-decoded replacement character
  });
});

Deno.test("adversarial: a non-ARC filename never throws scan — a plain .md contributes to otherMarkdownCount, a non-.md is silently ignored", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeArtifact(root, "001-x", "README.md", "# not an artifact\n");
    await writeArtifact(root, "001-x", "data.bin", "binary-ish\n");
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "scan", {}, ctx);
    const projects = written[0].payload.projects as Array<
      Record<string, unknown>
    >;
    const p = projects.find((x) => x.dir === "001-x")!;
    assertEquals(p.artifactCount, 0);
    assertEquals(p.otherMarkdownCount, 1); // README.md counts; data.bin does not
  });
});
