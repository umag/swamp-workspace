// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// Drift-guard contract test: binds the bundled skill documentation to the
// model (the source of truth). The model↔docs drift this guards against is
// real: the TDD test-review sub-cycle shipped in the model in 2026.04.30.5
// while the skills kept describing the old state machine, so agents wrote
// implementation code before the test-review gate.
//
// Two layers:
//   1. Per-file token assertions — each fact is asserted against the file
//      that is authoritative for it. These are the layer that catches the
//      original bug class.
//   2. Completeness sweep — every StateEnum value and every model method
//      name, enumerated DYNAMICALLY from the imported model (never a
//      hardcoded list), must appear as a backticked token in
//      state-machine.md. The backtick anchor keeps common-word names
//      (`plan`, `complete`, `close`, `iterate`) from false-passing via
//      incidental prose.
//
// Reads need `--allow-read=.` (see the `test` task in deno.json). A
// permission failure must never masquerade as an assertion failure — reads
// go through readDoc() which rethrows Deno.errors.NotCapable (the Deno 2.x
// class thrown when --allow-read is absent) with a loud, distinct message.

import { assert, assertStringIncludes } from "jsr:@std/assert@1";

import { model, StateEnum } from "./issue_lifecycle.ts";

// ============================================================================
// Helpers
// ============================================================================

const REPO_ROOT = new URL("../../", import.meta.url);

function docUrl(relPath: string): URL {
  return new URL(relPath, REPO_ROOT);
}

async function readDoc(relPath: string): Promise<string> {
  try {
    return await Deno.readTextFile(docUrl(relPath));
  } catch (err) {
    if (err instanceof Deno.errors.NotCapable) {
      throw new Error(
        `PERMISSION FAILURE (not an assertion failure): cannot read ` +
          `${relPath}. Run via 'deno task test' so --allow-read=. is set.`,
      );
    }
    throw err;
  }
}

const SKILL_DIR = ".claude/skills/issue-lifecycle/";
const REFS = `${SKILL_DIR}references/`;

// ============================================================================
// Layer 1: per-file token assertions (authoritative file per fact)
// ============================================================================

Deno.test("implementation.md documents the test gate, not the old direct transition", async () => {
  const doc = await readDoc(`${REFS}implementation.md`);
  assertStringIncludes(
    doc,
    "tests_approved",
    "implementation.md must reference the tests_approved gate",
  );
  // Unconditional by design: the rewritten doc must not quote the old
  // transition even as a contrast note — use prose, not the literal
  // backticked form, when describing what changed.
  assert(
    !doc.includes("`approved` → `implementing`"),
    "implementation.md still claims the pre-sub-cycle transition " +
      "'`approved` → `implementing`' — the model transitions approved → " +
      "writing_tests (issue_lifecycle.ts implement method). Replace with " +
      "the approved → writing_tests ↔ reviewing_tests → [tests_approved] " +
      "→ implementing gate description.",
  );
});

Deno.test("SKILL.md phase table dispatches the TDD sub-cycle states", async () => {
  const doc = await readDoc(`${SKILL_DIR}SKILL.md`);
  for (const token of ["writing_tests", "reviewing_tests"]) {
    assertStringIncludes(
      doc,
      token,
      `SKILL.md must dispatch state '${token}' to a phase reference file`,
    );
  }
});

Deno.test("autonomous-loop.md maps the test-review loop", async () => {
  const doc = await readDoc(`${REFS}autonomous-loop.md`);
  for (
    const token of [
      "review_tests",
      "iterate_tests",
      "tests_approved",
      "testReviewIteration",
      "MAX_TEST_ITERATIONS",
    ]
  ) {
    assertStringIncludes(
      doc,
      token,
      `autonomous-loop.md must map the test-review loop token '${token}'`,
    );
  }
});

Deno.test("state-machine.md record_review guard row includes reviewing_tests", async () => {
  const doc = await readDoc(`${REFS}state-machine.md`);
  const guardRow = doc
    .split("\n")
    .find((line) =>
      line.includes("`record_review`") && line.trim().startsWith("|")
    );
  assert(
    guardRow !== undefined,
    "state-machine.md must have a record_review row in the guard table",
  );
  assertStringIncludes(
    guardRow,
    "reviewing_tests",
    "record_review guard row must list reviewing_tests (model guard is " +
      "[reviewing, reviewing_tests, code_reviewing])",
  );
});

// ============================================================================
// Layer 2: completeness sweep — dynamic enumeration, backtick-anchored
// ============================================================================

Deno.test("every model state and method is documented in state-machine.md", async () => {
  const doc = await readDoc(`${REFS}state-machine.md`);
  // Enumerated from the model at runtime — a state/method added to the
  // model without documentation fails here automatically.
  const states: string[] = StateEnum.options;
  const methods: string[] = Object.keys(model.methods);
  const missing: string[] = [];
  for (const token of [...states, ...methods]) {
    if (!doc.includes(`\`${token}\``)) missing.push(token);
  }
  assert(
    missing.length === 0,
    `state-machine.md is missing backticked documentation for: ` +
      `${missing.join(", ")} (${missing.length} of ` +
      `${states.length} states + ${methods.length} methods). Bare prose ` +
      `mentions do not count — each identifier must appear as a ` +
      `backticked token.`,
  );
});
