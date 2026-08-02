/**
 * Adversarial suite: hostile/malformed inputs. `arckit_workspace.ts` was
 * BYTE-FROZEN when this suite was first authored; LB1 (HIGH, path-traversal
 * in `startProject`) was the first production change to land here, and its
 * two blocks are FIX-REGRESSION tests — they assert the guarded, POST-fix
 * behavior (rejection), not a current-behavior pin. LB2..LB7 (tracked in the
 * LOCAL `arckit-latent-bugs` issue-lifecycle model, NEVER a swamp.club Lab
 * issue) are now ALSO fixed: every former `pin (arckit-latent-bugs LBN,
 * SEVERITY):`-titled test below is a `fix regression (arckit-latent-bugs
 * LBN, SEVERITY):`-titled test asserting the guarded, POST-fix behavior,
 * plus new positive/negative coverage for each fix.
 *
 * No test in this suite ever writes outside its own `Deno.makeTempDir()`
 * tree (the datastore/no-escape rule) — LB1's synthetic traversal payloads
 * (all REJECTED inputs that create nothing), LB2's apply-overwrite, and
 * LB7's symlink targets all resolve strictly INSIDE the temp root.
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
// fix regression (arckit-latent-bugs LB1, HIGH): startProject now rejects any
// `dir` that is not a single NNN-slug segment — arckit_workspace.ts ~:1059,
// BEFORE readProjectState/Deno.mkdir/writeResource. parseProjectDir itself is
// UNCHANGED (stays permissive for scanWorkspace's read-model inventory); the
// allowlist guard lives only in startProject, the sole write-side factory.
// ---------------------------------------------------------------------------

Deno.test("fix regression (arckit-latent-bugs LB1, HIGH): startProject rejects dir '001-a/../b' — nothing created on disk, no projectState resource written", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    await assertRejects(
      () => run(model, "startProject", { title: "x", dir: "001-a/../b" }, ctx),
      Error,
      "NNN-slug segment",
    );

    // Neither the collapsed target "b" nor the literal "001-a" segment was
    // ever created — the guard fires before Deno.mkdir runs at all.
    await assertRejects(() => Deno.stat(`${root}/projects/b`));
    await assertRejects(() => Deno.stat(`${root}/projects/001-a`));
    assertEquals(written.length, 0);
  });
});

Deno.test("fix regression (arckit-latent-bugs LB1, HIGH): startProject rejects dir '002-nested/deep' — no nested directory created, no projectState resource written", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const { ctx, written } = makeCtx(root, templatesDir);
    // A dir with NO ".." still carries a "/" — same guard, same rejection;
    // this used to become a real nested directory the caller never asked
    // for by name.
    await assertRejects(
      () =>
        run(
          model,
          "startProject",
          { title: "x", dir: "002-nested/deep" },
          ctx,
        ),
      Error,
      "NNN-slug segment",
    );
    await assertRejects(() => Deno.stat(`${root}/projects/002-nested`));
    assertEquals(written.length, 0);
  });
});

Deno.test("fix regression (arckit-latent-bugs LB1, HIGH): legit single-segment NNN-slug dirs are unaffected by the allowlist guard", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    for (const dir of ["001-payment-gateway", "002-nested"]) {
      const { ctx, written } = makeCtx(root, templatesDir);
      await run(model, "startProject", { title: "x", dir }, ctx);
      const stat = await Deno.stat(`${root}/projects/${dir}`);
      assert(stat.isDirectory);
      assertEquals(written[0].payload.projectDir, dir);
    }
  });
});

Deno.test("fix regression (arckit-latent-bugs LB1, HIGH): synthetic traversal payloads are each rejected — nothing created under projects/, no projectState resource written", async () => {
  const payloads = [
    "001-a/../b",
    "002-nested/deep",
    "001-../../etc",
    "001-x/../../../tmp/pwn",
  ];
  for (const dir of payloads) {
    await withTempWorkspace(async (root, templatesDir) => {
      const { ctx, written } = makeCtx(root, templatesDir);
      await assertRejects(
        () => run(model, "startProject", { title: "x", dir }, ctx),
        Error,
        "NNN-slug segment",
      );
      // `${root}/projects` is created unconditionally at the top of
      // execute() before dir is validated, so it exists but must stay empty
      // for every rejected payload.
      const existing: string[] = [];
      for await (const e of Deno.readDir(`${root}/projects`)) {
        existing.push(e.name);
      }
      assertEquals(existing, []);
      assertEquals(written.length, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// fix regression (arckit-latent-bugs LB2, MEDIUM): migrateClassification
// apply=true now writes via backup + temp-then-rename, never a bare in-place
// overwrite — arckit_workspace.ts migrateClassification.execute, apply branch.
// ---------------------------------------------------------------------------

Deno.test("fix regression (arckit-latent-bugs LB2, MEDIUM): migrateClassification apply=true writes the new content atomically, leaving a .bak recovery sibling with the ORIGINAL content and no .tmp orphan", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const artifact = arcFilename("001", "REQ");
    const full = await writeArtifact(
      root,
      "001-x",
      artifact,
      docControlContent("OFFICIAL-SENSITIVE"),
    );
    const { ctx } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", { apply: true }, ctx);

    const onDisk = await Deno.readTextFile(full);
    assert(onDisk.includes("| **Classification** | Confidential |"));
    const backup = await Deno.readTextFile(`${full}.bak`);
    assert(backup.includes("| **Classification** | OFFICIAL-SENSITIVE |"));
    // Exactly the artifact + its .bak recovery sibling — no .tmp orphan.
    const siblings: string[] = [];
    for await (const e of Deno.readDir(`${root}/projects/001-x`)) {
      siblings.push(e.name);
    }
    assertEquals(siblings.sort(), [artifact, `${artifact}.bak`].sort());
  });
});

Deno.test("fix regression (arckit-latent-bugs LB2, MEDIUM): a second apply run that finds zero real changes performs no write and creates no new .bak", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const artifact = arcFilename("001", "REQ");
    const full = await writeArtifact(
      root,
      "001-x",
      artifact,
      docControlContent("OFFICIAL-SENSITIVE"),
    );
    const { ctx: ctx1 } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", { apply: true }, ctx1);
    const afterFirst = await Deno.readTextFile(full);
    const bakAfterFirst = await Deno.readTextFile(`${full}.bak`);

    const { ctx: ctx2, written } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", { apply: true }, ctx2);
    assertEquals(written[0].payload.totalChanges, 0);
    assertEquals(written[0].payload.files, []);

    // Idempotent: the artifact and its .bak are byte-identical to right
    // after the first run — the second run touched neither.
    assertEquals(await Deno.readTextFile(full), afterFirst);
    assertEquals(await Deno.readTextFile(`${full}.bak`), bakAfterFirst);
    const siblings: string[] = [];
    for await (const e of Deno.readDir(`${root}/projects/001-x`)) {
      siblings.push(e.name);
    }
    assertEquals(siblings.sort(), [artifact, `${artifact}.bak`].sort());
  });
});

// ---------------------------------------------------------------------------
// regression (arckit-latent-bugs LB3 fixed, LOW): a defaulted maxFileBytes
// global arg (10 MiB) now caps migrateClassification / template. A file
// UNDER the cap still round-trips whole — see the new oversize-skip cases
// below for the cap actually biting.
// ---------------------------------------------------------------------------

Deno.test("regression (arckit-latent-bugs LB3 fixed, LOW): migrateClassification reads and rewrites a large-but-under-cap artifact whole (default 10 MiB cap, 500 KB file)", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    // ~500KB — comfortably under the default 10 MiB cap, small enough for
    // fast CI, and large enough to demonstrate a genuine whole round-trip.
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
    assertEquals(written[0].payload.skipped, []);
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

Deno.test("regression (arckit-latent-bugs LB3 fixed, LOW): template serves a large-but-under-cap bundled file's FULL content (default 10 MiB cap, 500 KB file)", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const big = "# Requirements\n" + "y".repeat(500_000);
    await writeTemplateFile(templatesDir, "requirements-template.md", big);
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "template", { command: "requirements" }, ctx);
    assertEquals((written[0].payload.content as string).length, big.length);
  });
});

Deno.test("fix regression (arckit-latent-bugs LB3, LOW): migrateClassification skips an oversize artifact via a small overridden maxFileBytes — not read, not written, recorded in skipped with reason 'oversize'", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const content = docControlContent("OFFICIAL");
    const full = await writeArtifact(
      root,
      "001-x",
      arcFilename("001", "REQ"),
      content,
    );
    const { ctx, written } = makeCtx(root, templatesDir);
    ctx.globalArgs.maxFileBytes = 10; // far below the artifact's real size
    await run(model, "migrateClassification", { apply: true }, ctx);
    const payload = written[0].payload;
    assertEquals(payload.totalChanges, 0);
    assertEquals(payload.files, []);
    assertEquals(payload.skipped, [{
      relPath: `001-x/${arcFilename("001", "REQ")}`,
      reason: "oversize",
    }]);
    // Untouched on disk — the cap-check happens before any read, so the
    // classification value is never even inspected.
    assertEquals(await Deno.readTextFile(full), content);
  });
});

Deno.test("fix regression (arckit-latent-bugs LB3, LOW): template rejects a bundled file over a small overridden maxFileBytes, before any read", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await writeTemplateFile(
      templatesDir,
      "requirements-template.md",
      "# Requirements\n" + "y".repeat(1000),
    );
    const { ctx } = makeCtx(root, templatesDir);
    ctx.globalArgs.maxFileBytes = 10;
    await assertRejects(
      () => run(model, "template", { command: "requirements" }, ctx),
      Error,
      "exceeds max size",
    );
  });
});

// ---------------------------------------------------------------------------
// fix regression (arckit-latent-bugs LB4, LOW): `projectState.state` is now
// a closed enum (PROJECT_STATES) — arckit_workspace.ts ProjectStateSchema +
// readProjectState, the sole reader used by status/advance/skipPhase/abandon.
// A corrupted/hand-edited/datastore-restored unknown-phase value now fails
// to parse instead of silently reaching gateFor/nextPhase. NOT reachable via
// the public API (startProject only ever writes a value from PHASES); these
// tests seed the resource directly, bypassing startProject, to simulate the
// corruption scenario.
// ---------------------------------------------------------------------------

Deno.test("fix regression (arckit-latent-bugs LB4, LOW): status on a project whose state is an unknown phase now REJECTS with 'Corrupted project state' (no vacuous gateSatisfied=true)", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await Deno.mkdir(`${root}/projects/001-x`, { recursive: true });
    const { ctx } = makeCtx(root, templatesDir);
    const at = new Date().toISOString();
    await ctx.writeResource("projectState", "001-x", {
      projectDir: "001-x",
      id: "001",
      title: "corrupted",
      profile: "standard",
      state: "totally-bogus-phase", // outside PROJECT_STATES entirely
      skipped: [],
      history: [],
      createdAt: at,
      updatedAt: at,
    });
    await assertRejects(
      () => run(model, "status", { project: "001-x" }, ctx),
      Error,
      "Corrupted project state",
    );
  });
});

Deno.test("fix regression (arckit-latent-bugs LB4, LOW): advance on a project whose state is an unknown phase now REJECTS (no auto-complete)", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await Deno.mkdir(`${root}/projects/001-x`, { recursive: true });
    const { ctx } = makeCtx(root, templatesDir);
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
    await assertRejects(
      () => run(model, "advance", { project: "001-x" }, ctx),
      Error,
      "Corrupted project state",
    );
  });
});

// ---------------------------------------------------------------------------
// fix regression (arckit-latent-bugs LB5, LOW): project-id allocation no
// longer breaks past 999 — arckit_workspace.ts nextProjectDir /
// parseProjectDir / the startProject allowlist guard all widen to `\d{3,}`.
// ---------------------------------------------------------------------------

Deno.test("fix regression (arckit-latent-bugs LB5, LOW): startProject SUCCEEDS once the highest existing project id is 999 — allocates '1000-slug' and writes a projectState with id '1000'", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await Deno.mkdir(`${root}/projects/999-last`, { recursive: true });
    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "startProject", { title: "one too many" }, ctx);
    assertEquals(written[0].name, "1000-one-too-many");
    assertEquals(written[0].payload.projectDir, "1000-one-too-many");
    assertEquals(written[0].payload.id, "1000");
    const stat = await Deno.stat(`${root}/projects/1000-one-too-many`);
    assert(stat.isDirectory);
  });
});

// ---------------------------------------------------------------------------
// fix regression (arckit-latent-bugs LB6, LOW/info): templates() and
// provisionTemplates() are now reconciled — a bundled file with no
// TEMPLATE_MAP command still has no command (correct — it isn't one), but
// it now surfaces in templates()'s new `unmappedFiles[]`, so the two
// methods agree on the full set of bundled files instead of diverging.
// ---------------------------------------------------------------------------

Deno.test("fix regression (arckit-latent-bugs LB6, LOW/info): a bundled template file with no TEMPLATE_MAP entry is absent from templates()'s templates[] (correct — no command) but now VISIBLE in unmappedFiles[], and is still copied by provisionTemplates()", async () => {
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
      "templates() must not surface a file with no TEMPLATE_MAP command as a command entry",
    );
    assertEquals(w1[0].payload.unmappedFiles, [
      "framework-overview-template.md",
    ]);

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
// fix regression (arckit-latent-bugs LB7, LOW/info): symlinked artifacts and
// project directories are now surfaced by scan — listFilesRecursive /
// scanWorkspace resolve a symlink entry's target kind via Deno.stat. Write
// safety is guarded separately: migrateClassification's apply branch skips
// (never writes through) a symlinked artifact — see the second test below.
// ---------------------------------------------------------------------------

Deno.test("fix regression (arckit-latent-bugs LB7, LOW/info): a symlinked ARC-* artifact is now VISIBLE to scan — both the symlinked REQ and the ordinary RISK are inventoried", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await Deno.mkdir(`${root}/projects/001-x`, { recursive: true });
    await Deno.writeTextFile(`${root}/outside-real-target.md`, "# real\n");
    await Deno.symlink(
      `${root}/outside-real-target.md`,
      `${root}/projects/001-x/${arcFilename("001", "REQ")}`,
    );
    // A second, ordinary (non-symlink) artifact in the same project proves
    // the scan otherwise works.
    await writeArtifact(root, "001-x", arcFilename("001", "RISK"));

    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "scan", {}, ctx);
    const projects = written[0].payload.projects as Array<
      Record<string, unknown>
    >;
    const p = projects.find((x) => x.dir === "001-x")!;
    assertEquals(p.artifactCount, 2); // both REQ (symlinked) and RISK
    const artifacts = p.artifacts as Array<Record<string, unknown>>;
    assert(artifacts.some((a) => a.docType === "REQ"));
    assert(artifacts.some((a) => a.docType === "RISK"));
  });
});

Deno.test("fix regression (arckit-latent-bugs LB7, LOW/info): a symlinked project DIRECTORY is now inventoried by scan", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    const realDir = `${root}/outside-real-project`;
    await Deno.mkdir(realDir, { recursive: true });
    await Deno.writeTextFile(
      `${realDir}/${arcFilename("002", "REQ")}`,
      "# requirements\n",
    );
    await Deno.mkdir(`${root}/projects`, { recursive: true });
    await Deno.symlink(realDir, `${root}/projects/002-linked`);

    const { ctx, written } = makeCtx(root, templatesDir);
    await run(model, "scan", {}, ctx);
    const projects = written[0].payload.projects as Array<
      Record<string, unknown>
    >;
    const p = projects.find((x) => x.dir === "002-linked");
    assert(p, "symlinked project directory must be inventoried");
    assertEquals(p!.artifactCount, 1);
    const artifacts = p!.artifacts as Array<Record<string, unknown>>;
    assertEquals(artifacts[0].docType, "REQ");
  });
});

Deno.test("fix regression (arckit-latent-bugs LB7, LOW/info): migrateClassification apply=true over a symlinked artifact records it in skipped with reason 'symlink' and leaves the symlink target unwritten; report-only still proposes the change", async () => {
  await withTempWorkspace(async (root, templatesDir) => {
    await Deno.mkdir(`${root}/projects/001-x`, { recursive: true });
    const targetPath = `${root}/outside-real-target.md`;
    await Deno.writeTextFile(targetPath, docControlContent("OFFICIAL"));
    const linkPath = `${root}/projects/001-x/${arcFilename("001", "REQ")}`;
    await Deno.symlink(targetPath, linkPath);

    // Report-only: reads through the symlink and still proposes the change
    // (read is safe — confinement only matters for writes).
    const { ctx: ctx1, written: w1 } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", {}, ctx1);
    assertEquals(w1[0].payload.totalChanges, 1);
    assertEquals(w1[0].payload.skipped, []);

    // apply=true: skipped, not written — the symlink target is confined
    // (this is the write-safety cross-cut with LB1/LB2).
    const { ctx: ctx2, written: w2 } = makeCtx(root, templatesDir);
    await run(model, "migrateClassification", { apply: true }, ctx2);
    const payload = w2[0].payload;
    assertEquals(payload.totalChanges, 0);
    assertEquals(payload.files, []);
    assertEquals(payload.skipped, [{
      relPath: `001-x/${arcFilename("001", "REQ")}`,
      reason: "symlink",
    }]);
    const onDisk = await Deno.readTextFile(targetPath);
    assert(onDisk.includes("OFFICIAL")); // symlink target unwritten
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
