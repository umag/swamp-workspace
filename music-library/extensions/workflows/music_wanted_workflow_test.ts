// Structural regression test over the packaged music-wanted workflow body,
// music-library/extensions/workflows/music-wanted.yaml.
//
// This is one of only two automated controls that exist for that artefact.
// `swamp workflow validate` cannot be pointed at it -- a workflow file
// without a top-level `id:` is not registered under either name, and
// `swamp extension push --dry-run` performs no workflow validation
// whatsoever (a workflow with duplicate job names and dangling dependsOn
// references was archived without complaint). The only other control is the
// manual, mandatory dry run against the LIVE copy, documented in the
// workflow's own description.
//
// The assertions here are deliberately structural, not a regex over the
// folded YAML scalars: absence of a top-level `id` key, per-step
// `allowFailure` values, and literal (never dynamic) step targets are the
// load-bearing decisions this plan makes, and a regex is exactly the
// brittleness that would silently stop catching a regression in any of
// them.
//
// Run: deno test --allow-env=FC_NUM_RUNS --allow-read=extensions/workflows
//        --permit-no-files extensions/workflows/

import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse as parseYaml } from "jsr:@std/yaml@1";

const WORKFLOW_PATH = new URL("./music-wanted.yaml", import.meta.url);

interface AssertTask {
  type: "assert";
  expr: string;
  message: string;
  severity: string;
}

interface ModelMethodTask {
  type: "model_method";
  modelIdOrName: string;
  methodName: string;
  inputs?: Record<string, unknown>;
}

interface WorkflowStep {
  name: string;
  allowFailure: boolean;
  task: AssertTask | ModelMethodTask;
}

interface WorkflowJob {
  name: string;
  steps: WorkflowStep[];
}

interface WorkflowDoc {
  name: string;
  description: string;
  tags: Record<string, unknown>;
  jobs: WorkflowJob[];
}

async function readRawWorkflow(): Promise<string> {
  return await Deno.readTextFile(WORKFLOW_PATH);
}

async function loadWorkflow(): Promise<WorkflowDoc> {
  const raw = await readRawWorkflow();
  return parseYaml(raw) as WorkflowDoc;
}

function allSteps(doc: WorkflowDoc): WorkflowStep[] {
  return doc.jobs.flatMap((job) => job.steps);
}

Deno.test("music-wanted workflow: name is exactly @magistr/music-wanted-sequence", async () => {
  const doc = await loadWorkflow();
  assertEquals(doc.name, "@magistr/music-wanted-sequence");
});

Deno.test("music-wanted workflow: carries no top-level id key -- that is what leaves it unregistered until `swamp workflow create`", async () => {
  const raw = await readRawWorkflow();
  const doc = parseYaml(raw) as Record<string, unknown>;
  assert(
    !("id" in doc),
    "a packaged workflow must not carry an id: a file with no id is not " +
      "registered by `extension pull` / `extension source add` under any name",
  );
});

const ASSERT_STEP_NAMES = [
  "assert-artist-dimension-present",
  "assert-album-dimension-present",
  "read-discography-sync-cursor",
  "assert-resolve-produced-something",
  "assert-artist-map-floor",
  "assert-sync-coverage",
  "assert-sync-handoff",
  "assert-catalog-completeness",
  "assert-derive-existence",
  "assert-want-total-band",
];

Deno.test("music-wanted workflow: all ten assert-type step names are present, gate 1 (preflight-dimensions) being the first two", async () => {
  const doc = await loadWorkflow();
  const assertStepNames = allSteps(doc)
    .filter((step) => step.task.type === "assert")
    .map((step) => step.name);
  for (const name of ASSERT_STEP_NAMES) {
    assert(assertStepNames.includes(name), `missing assert step "${name}"`);
  }
  assertEquals(
    assertStepNames.length,
    ASSERT_STEP_NAMES.length,
    "expected exactly ten assert-type steps, no more, no fewer",
  );
  assertEquals(
    assertStepNames[0],
    "assert-artist-dimension-present",
    "gate 1 (preflight-dimensions) must be implemented by the first assert step",
  );
  assertEquals(
    assertStepNames[1],
    "assert-album-dimension-present",
    "gate 1 (preflight-dimensions) must be implemented by the second assert step",
  );
});

const GATE_NAMES = [
  "preflight-dimensions",
  "resolve-produced-something",
  "artist-map-floor",
  "sync-coverage",
  "sync-handoff",
  "catalog-completeness",
  "derive-existence",
  "want-total-band",
];

Deno.test("music-wanted workflow: the eight gate names appear as the leading token of their assert step's message -- no step is named after a gate", async () => {
  const doc = await loadWorkflow();
  const steps = allSteps(doc);
  for (const gate of GATE_NAMES) {
    const found = steps.some((step) =>
      step.task.type === "assert" &&
      (step.task as AssertTask).message.trimStart().startsWith(`${gate}:`)
    );
    assert(found, `no assert step's message leads with gate name "${gate}:"`);
  }
});

Deno.test("music-wanted workflow: every assert step is allowFailure: false except read-discography-sync-cursor, which is true -- nine false, one true", async () => {
  const doc = await loadWorkflow();
  const assertSteps = allSteps(doc).filter((step) =>
    step.task.type === "assert"
  );
  let falseCount = 0;
  let trueCount = 0;
  for (const step of assertSteps) {
    if (step.name === "read-discography-sync-cursor") {
      assertEquals(
        step.allowFailure,
        true,
        "read-discography-sync-cursor is informational-only and must allow failure",
      );
      trueCount++;
    } else {
      assertEquals(
        step.allowFailure,
        false,
        `${step.name} is a real gate and must not allow failure`,
      );
      falseCount++;
    }
  }
  assertEquals(falseCount, 9);
  assertEquals(trueCount, 1);
});

Deno.test("music-wanted workflow: the three model_method steps target the plain scalars music, musicbrainz, music -- never a dynamic expression", async () => {
  const doc = await loadWorkflow();
  const targets = allSteps(doc)
    .filter((step) => step.task.type === "model_method")
    .map((step) => (step.task as ModelMethodTask).modelIdOrName);
  assertEquals(
    targets,
    ["music", "musicbrainz", "music"],
    "a dynamic step target does not remove swamp's step-input validation -- " +
      "it keeps the check and makes it report passed: true while verifying " +
      "nothing, so the targets must stay literal",
  );
});

Deno.test("music-wanted workflow: the corrected gate-6 sentence is present at both sites and the retired 'fails only on a cold catalog' claim is gone", async () => {
  const raw = await readRawWorkflow();
  const correctedClaim = raw.includes("resolved an artist absent") &&
    raw.includes("no dryRun guard") &&
    raw.includes("batchSize 0 caches nothing");
  assert(
    correctedClaim,
    "the true gate-6 rule (fails on any dry run that resolves an artist " +
      "absent from the discography cache, since resolve has no dryRun " +
      "guard) must be present",
  );
  assert(
    !raw.includes("cold catalog"),
    "the false 'fails only on a cold catalog' claim must not appear",
  );
});

Deno.test("music-wanted workflow: description's first paragraph is the not-runnable-on-install caveat", async () => {
  const doc = await loadWorkflow();
  const firstParagraph = doc.description.split("\n\n")[0];
  assert(
    firstParagraph.includes("Not runnable on install"),
    `first paragraph must open with the not-runnable caveat, got: ${
      firstParagraph.slice(0, 160)
    }`,
  );
});

Deno.test("music-wanted workflow: none of the retired phrases 775 / 2026-08-06 / ext-canary-nightly appear anywhere", async () => {
  const raw = await readRawWorkflow();
  for (const phrase of ["775", "2026-08-06", "ext-canary-nightly"]) {
    assert(!raw.includes(phrase), `retired phrase "${phrase}" must not appear`);
  }
});
