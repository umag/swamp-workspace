// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// Drift-guard contract test: binds the bundled skill documentation to the
// model (the source of truth). The model↔docs drift this guards against is
// real: the TDD test-review sub-cycle once shipped in the model while the
// skills described a different state machine. As of 2026.09.20.1 that
// sub-cycle is REMOVED — `implement` transitions `approved` → `implementing`
// directly — and the Layer-1 assertions below now pin its ABSENCE so the
// phase cannot silently creep back into the docs without the model.
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

import { model, MODEL_VERSION, StateEnum } from "./issue_lifecycle.ts";

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

// Tokens that must no longer appear in ANY skill doc — the removed
// test-review sub-cycle. A regression that re-introduces the phase in the
// docs (without the model) trips this immediately.
const REMOVED_PHASE_TOKENS = [
  "writing_tests",
  "reviewing_tests",
  "review_tests",
  "iterate_tests",
  "tests_approved",
  "testReviewIteration",
  "test_review",
  "MAX_TEST_ITERATIONS",
];

Deno.test("implementation.md documents the direct approved → implementing transition", async () => {
  const doc = await readDoc(`${REFS}implementation.md`);
  assertStringIncludes(
    doc,
    "implementing",
    "implementation.md must describe the implementing phase",
  );
  for (const token of REMOVED_PHASE_TOKENS) {
    assert(
      !doc.includes(token),
      `implementation.md still references the removed test-phase token ` +
        `'${token}' — the model now transitions approved → implementing ` +
        `directly (issue_lifecycle.ts implement method).`,
    );
  }
});

Deno.test("SKILL.md no longer dispatches the removed test-phase states", async () => {
  const doc = await readDoc(`${SKILL_DIR}SKILL.md`);
  for (const token of REMOVED_PHASE_TOKENS) {
    assert(
      !doc.includes(token),
      `SKILL.md still references removed test-phase token '${token}'`,
    );
  }
});

Deno.test("autonomous-loop.md no longer maps a test-review loop", async () => {
  const doc = await readDoc(`${REFS}autonomous-loop.md`);
  for (const token of REMOVED_PHASE_TOKENS) {
    assert(
      !doc.includes(token),
      `autonomous-loop.md still references removed test-phase token ` +
        `'${token}'`,
    );
  }
});

Deno.test("state-machine.md record_review guard row is [reviewing, code_reviewing]", async () => {
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
  assert(
    !guardRow.includes("reviewing_tests"),
    "record_review guard row must NOT list reviewing_tests (model guard is " +
      "now [reviewing, code_reviewing])",
  );
  assertStringIncludes(
    guardRow,
    "code_reviewing",
    "record_review guard row must still list code_reviewing",
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

// ============================================================================
// Version pinning
// ============================================================================

Deno.test("MODEL_VERSION equals the declaration's literal version", () => {
  // These are two separate literals on purpose: the quality checker and
  // swamp's push validator both require `version:` to be a plain quoted
  // string, so it cannot reference the constant. This test is what keeps
  // them from drifting — an attestation stamped with a stale modelVersion
  // would misattribute the evidence.
  assert(
    MODEL_VERSION === model.version,
    `MODEL_VERSION '${MODEL_VERSION}' != model.version '${model.version}'`,
  );
});
