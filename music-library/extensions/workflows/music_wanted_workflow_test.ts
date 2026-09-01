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
// Run: deno task test (from the music-library/ package root). See
// deno.json's own "test" task for the exact permission set -- it widened to
// cover manifest.yaml and README.md so this file's gate-count coupling test
// (see below) can read them; do not hand-copy the command here again, it
// will drift the way the previous verbatim copy did.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse as parseYaml } from "jsr:@std/yaml@1";
import { model } from "../models/music_library.ts";

const WORKFLOW_PATH = new URL("./music-wanted.yaml", import.meta.url);
const MANIFEST_PATH = new URL("../../manifest.yaml", import.meta.url);
const README_PATH = new URL("../../README.md", import.meta.url);

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

interface JobDependency {
  job: string;
  condition: { type: string };
}

interface WorkflowJob {
  name: string;
  dependsOn: JobDependency[];
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

function stepByName(doc: WorkflowDoc, name: string): WorkflowStep {
  const step = allSteps(doc).find((s) => s.name === name);
  assert(step, `step "${name}" not found`);
  return step!;
}

function sortedKeys(obj: Record<string, unknown> | undefined): string[] {
  return Object.keys(obj ?? {}).sort();
}

// Every way the workflow can name an instance inside a folded scalar, both
// resolving to the same workflow input:
//   modelName == "${{ inputs.headphonesInstance }}"   (plain prose / expr)
//   modelName == "' + inputs.headphonesInstance + '"  (inside a ${{ }} block,
//                                                      where nesting is illegal)
// Returns the INPUT NAME each site reads, so a site retargeted to a different
// input -- or hardcoded back to a bare literal -- is still visible.
function extractInstanceLiterals(text: string): string[] {
  const re = /modelName == "([^"]*)"/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.push(inputNameOf(m[1]));
  }
  return found;
}

// Normalizes one captured instance site to the input name it reads, or
// returns it unchanged when it is a bare literal (which is then reported as a
// mismatch by the caller, since the resolve step binds an input reference).
function inputNameOf(site: string): string {
  const templated = /^\$\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}$/.exec(site);
  if (templated) return templated[1];
  const concatenated = /^'\s*\+\s*inputs\.([A-Za-z0-9_]+)\s*\+\s*'$/.exec(site);
  if (concatenated) return concatenated[1];
  return site;
}

// The single source of truth for "which input is this run's headphones
// instance wired to": read from the resolve step's own binding, never
// hardcoded, so a legitimate rename of the input stays green everywhere this
// is used (T6 and T8) instead of requiring two independent edits to stay in
// sync.
function headphonesInstance(doc: WorkflowDoc): string {
  const resolveStep = stepByName(doc, "resolve-artists");
  const hp = (resolveStep.task as ModelMethodTask).inputs?.headphonesInstance;
  assert(
    typeof hp === "string" && hp.length > 0,
    "resolve-artists.headphonesInstance must be a non-empty string",
  );
  return inputNameOf(hp);
}

// The declared default of one workflow input -- what an operator who passes
// nothing actually gets. This is what keeps parameterization non-breaking.
function inputDefault(doc: WorkflowDoc, name: string): unknown {
  const props = (doc as unknown as {
    inputs?: { properties?: Record<string, { default?: unknown }> };
  }).inputs?.properties;
  assert(props, "workflow declares no inputs.properties block");
  const prop = props[name];
  assert(prop, `workflow declares no input named "${name}"`);
  return prop.default;
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
  "assert-headphones-seed",
  "read-discography-sync-cursor",
  "assert-resolve-produced-something",
  "assert-artist-map-floor",
  "assert-sync-coverage",
  "assert-sync-handoff",
  "assert-catalog-completeness",
  "assert-derive-existence",
  "assert-want-total-band",
];

Deno.test("music-wanted workflow: all eleven assert-type step names are present, gate 1 (preflight-dimensions) being the first two and gate 9 (preflight-seed) the third", async () => {
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
    "expected exactly eleven assert-type steps, no more, no fewer",
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
  assertEquals(
    assertStepNames[2],
    "assert-headphones-seed",
    "gate 9 (preflight-seed) must be the third assert step, immediately " +
      "after gate 1's two steps and before read-discography-sync-cursor",
  );
});

const GATE_NAMES = [
  "preflight-dimensions",
  "preflight-seed",
  "resolve-produced-something",
  "artist-map-floor",
  "sync-coverage",
  "sync-handoff",
  "catalog-completeness",
  "derive-existence",
  "want-total-band",
];

Deno.test("music-wanted workflow: the nine gate names appear as the leading token of their assert step's message -- no step is named after a gate", async () => {
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

Deno.test("music-wanted workflow: every step is allowFailure: false except read-discography-sync-cursor, which is true -- pinned across EVERY task.type, not just assert, thirteen false one true", async () => {
  const doc = await loadWorkflow();
  // Deliberately NOT filtered to task.type === "assert": a model_method step
  // (e.g. sync-artist-discographies) flipped to allowFailure: true opens the
  // fail-closed gate chain exactly as silently as an unpinned assert would,
  // and swamp treats a failed-but-allowed step as non-fatal to its job
  // regardless of task type.
  const steps = allSteps(doc);
  let falseCount = 0;
  let trueCount = 0;
  for (const step of steps) {
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
        `${step.name} (task.type=${step.task.type}) must not allow failure`,
      );
      falseCount++;
    }
  }
  assertEquals(falseCount, 13);
  assertEquals(trueCount, 1);
});

Deno.test("music-wanted workflow: job dependency edges are preflight <- resolve <- sync <- derive, each non-preflight edge gated on {type: succeeded} -- severing any of these lets a downstream job run after an upstream failure", async () => {
  const doc = await loadWorkflow();
  const jobsByName = new Map(doc.jobs.map((job) => [job.name, job]));

  const preflight = jobsByName.get("preflight");
  assert(preflight, 'job "preflight" not found');
  assertEquals(
    preflight!.dependsOn,
    [],
    "preflight is the entry job and must have no upstream dependency",
  );

  const expectedUpstream: Record<string, string> = {
    resolve: "preflight",
    sync: "resolve",
    derive: "sync",
  };
  for (const [jobName, upstream] of Object.entries(expectedUpstream)) {
    const job = jobsByName.get(jobName);
    assert(job, `job "${jobName}" not found`);
    assertEquals(
      job!.dependsOn.length,
      1,
      `job "${jobName}" must depend on exactly one upstream job`,
    );
    assertEquals(
      job!.dependsOn[0].job,
      upstream,
      `job "${jobName}" must depend on job "${upstream}"`,
    );
    assertEquals(
      job!.dependsOn[0].condition.type,
      "succeeded",
      `job "${jobName}"'s dependency on "${upstream}" must be gated on ` +
        "{type: succeeded} -- a present-but-unconditioned or severed " +
        "dependsOn lets that job run even after its upstream job failed",
    );
  }
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

Deno.test("music-wanted workflow: the three explicit instance bindings (headphonesInstance x2, musicbrainzInstance x1) each read a declared input whose DEFAULT is the original literal -- parameterized, and non-breaking for an operator who passes nothing", async () => {
  const doc = await loadWorkflow();

  const resolveStep = stepByName(doc, "resolve-artists");
  const syncStep = stepByName(doc, "sync-artist-discographies");
  const wantedStep = stepByName(doc, "wanted");

  const resolveInputs = (resolveStep.task as ModelMethodTask).inputs ?? {};
  const syncInputs = (syncStep.task as ModelMethodTask).inputs ?? {};
  const wantedInputs = (wantedStep.task as ModelMethodTask).inputs ?? {};

  // The bindings are input references, not bare literals -- that is what
  // lets `--input headphonesInstance=<name>` retarget a run with no file
  // edit, instead of the operator hitting preflight-seed and being told to
  // hand-edit every literal in this file.
  assertEquals(
    resolveInputs.headphonesInstance,
    "${{ inputs.headphonesInstance }}",
  );
  assertEquals(
    resolveInputs.musicbrainzInstance,
    "${{ inputs.musicbrainzInstance }}",
  );
  assertEquals(
    wantedInputs.musicbrainzInstance,
    "${{ inputs.musicbrainzInstance }}",
  );

  // ...and each referenced input DEFAULTS to the literal that used to be
  // hardcoded, so a run that passes nothing binds exactly what it bound
  // before this change. A mutation that parameterized the binding but
  // dropped (or changed) the default would silently retarget every existing
  // operator's run -- the precise breakage this test exists to prevent.
  assertEquals(
    inputDefault(doc, "headphonesInstance"),
    "headphones",
    "headphonesInstance's default must stay the pre-parameterization literal",
  );
  assertEquals(
    inputDefault(doc, "musicbrainzInstance"),
    "musicbrainz",
    "musicbrainzInstance's default must stay the pre-parameterization literal",
  );

  for (
    const [label, value] of [
      ["resolve-artists.headphonesInstance", resolveInputs.headphonesInstance],
      [
        "resolve-artists.musicbrainzInstance",
        resolveInputs.musicbrainzInstance,
      ],
      ["wanted.musicbrainzInstance", wantedInputs.musicbrainzInstance],
    ] as const
  ) {
    assert(
      typeof value === "string" &&
        /^\$\{\{\s*inputs\.[A-Za-z0-9_]+\s*\}\}$/.test(value),
      `${label} must be exactly one \${{ inputs.<name> }} reference and ` +
        `nothing else, got: ${String(value)}`,
    );
  }

  // Complete sorted key-set equality, not just presence of the three added
  // keys: a step that dropped an existing key (e.g. `refresh`) while adding
  // an unrelated declared-but-wrong one (mutation K) is invisible to
  // `swamp workflow validate` -- measured 22 passed / 0 failed with the
  // identical check-name set on a scratch full-copy of this file -- so this
  // is the only mechanism that observes it.
  assertEquals(
    sortedKeys(resolveInputs),
    ["headphonesInstance", "musicbrainzInstance", "refresh"],
    "resolve-artists step inputs must carry exactly these keys",
  );
  assertEquals(
    sortedKeys(syncInputs),
    ["artistMbids", "batchSize", "ttlMs"],
    "sync-artist-discographies step inputs must carry exactly these keys",
  );
  assertEquals(
    sortedKeys(wantedInputs),
    ["musicbrainzInstance", "targetQuality"],
    "wanted step inputs must carry exactly these keys",
  );
});

Deno.test("music-wanted workflow: every music-targeted step's inputs are declared argument names on that method (sync-artist-discographies belongs to the separately-versioned @magistr/musicbrainz and is out of scope -- not importable here, so T4's key-set equality is its only observer)", async () => {
  const doc = await loadWorkflow();
  const musicSteps: Array<{ step: WorkflowStep; methodName: string }> = [
    {
      step: stepByName(doc, "resolve-artists"),
      methodName: "resolve-artists",
    },
    { step: stepByName(doc, "wanted"), methodName: "wanted" },
  ];
  const methods = model.methods as unknown as Record<
    string,
    { arguments: { shape: Record<string, unknown> } }
  >;
  for (const { step, methodName } of musicSteps) {
    const task = step.task as ModelMethodTask;
    assertEquals(
      task.modelIdOrName,
      "music",
      `step "${step.name}" is expected to target the "music" instance`,
    );
    const method = methods[methodName];
    assert(method, `method "${methodName}" not found on model.methods`);
    const declared = new Set(Object.keys(method.arguments.shape));
    for (const key of Object.keys(task.inputs ?? {})) {
      assert(
        declared.has(key),
        `step "${step.name}" passes input "${key}" which is not a ` +
          `declared argument of method "${methodName}" (declared: ${
            [...declared].join(", ")
          })`,
      );
    }
  }
});

Deno.test("music-wanted workflow: the new preflight-seed gate's expr AND message read ONLY the instance the resolve step passes as headphonesInstance", async () => {
  const doc = await loadWorkflow();
  const hp = headphonesInstance(doc);

  const gate = stepByName(doc, "assert-headphones-seed");
  const task = gate.task as AssertTask;
  assertEquals(task.type, "assert");

  const exprLiterals = extractInstanceLiterals(task.expr);
  const messageLiterals = extractInstanceLiterals(task.message);

  assert(
    exprLiterals.length > 0,
    'assert-headphones-seed\'s expr must name an instance via modelName == "..."',
  );
  assert(
    messageLiterals.length > 0,
    'assert-headphones-seed\'s message must name an instance via modelName == "..."',
  );

  // Extended to expr AND message (not expr alone): MSG-1 issues its own
  // data.query calls to report what it measured, so a retarget of one of
  // those message-only queries while leaving the expr and the step input
  // alone would be invisible to an expr-only check.
  for (const literal of [...exprLiterals, ...messageLiterals]) {
    assertEquals(
      literal,
      hp,
      `assert-headphones-seed must read ONLY the instance the resolve ` +
        `step passes ("${hp}"), found a modelName literal "${literal}" ` +
        "naming a different instance",
    );
  }
});

Deno.test("music-wanted workflow: the gate count word (case-insensitive) matches GATE_NAMES.length in the workflow description, manifest.yaml and README.md, and no stale 'eight gates' survives", async () => {
  const doc = await loadWorkflow();
  const words: Record<number, string> = { 8: "eight", 9: "nine" };
  const expectedWord = words[GATE_NAMES.length];
  assert(expectedWord, `no number word mapped for ${GATE_NAMES.length} gates`);

  const manifestRaw = await Deno.readTextFile(MANIFEST_PATH);
  const readmeRaw = await Deno.readTextFile(README_PATH);

  const sites: Array<[string, string]> = [
    ["workflow description", doc.description],
    ["manifest.yaml", manifestRaw],
    ["README.md", readmeRaw],
  ];

  const countRe = /\b(eight|nine)\s+gates\b/i;
  for (const [label, text] of sites) {
    const m = countRe.exec(text);
    assert(m, `${label} does not contain a "<word> gates" count phrase`);
    assertEquals(
      m[1].toLowerCase(),
      expectedWord,
      `${label} says "${m[1]} gates" but GATE_NAMES.length is ` +
        `${GATE_NAMES.length} ("${expectedWord}")`,
    );
    assert(
      !/\beight\s+gates\b/i.test(text),
      `${label} still contains a stale "eight gates" count phrase`,
    );
  }

  assert(
    doc.description.includes("(9) preflight-seed"),
    "workflow description must enumerate '(9) preflight-seed' immediately " +
      "after gate (1)",
  );
});

Deno.test("music-wanted workflow: the two headphones recovery messages name the instance the resolve step actually passes, and the retired unqualified phrase is gone everywhere it is parsed from", async () => {
  const doc = await loadWorkflow();
  const hp = headphonesInstance(doc);

  // Clause (i) is checked against PARSED text (doc.description and each
  // step's parsed message), never raw file text. The retired phrase is
  // fold-split across a line break in the raw YAML today (PKG:252-253:
  // "...check that the" / "headphones seed instance is reachable..."), so a
  // raw substring search sees only the assert-resolve-produced-something
  // site and silently misses the assert-artist-map-floor site. YAML parsing
  // resolves the fold into a single space-joined string, which is what
  // makes semantic (not merely textual) containment testable here.
  const retiredPhrase = "the headphones seed instance";
  assert(
    !doc.description.includes(retiredPhrase),
    "retired phrase must not survive in the workflow description",
  );
  for (const step of allSteps(doc)) {
    if (step.task.type !== "assert") continue;
    assert(
      !(step.task as AssertTask).message.includes(retiredPhrase),
      `retired phrase "${retiredPhrase}" must not survive in step ` +
        `"${step.name}"'s message`,
    );
  }

  // Both message sites name the instance by TEMPLATE reference, the form an
  // operator's --input actually reaches; `hp` is the input name, so build
  // the site text from it rather than hardcoding either half.
  const hpSite = "${{ inputs." + hp + " }}";

  // Clauses (ii)/(iii), per site, derived from HP rather than hardcoded --
  // a hardcoded "headphones" would go red on a legitimate retarget and,
  // being satisfied by the new gate's own message alone, could not see
  // MSG-2 or MSG-3 reverting to stale wording.
  for (
    const step of [
      stepByName(doc, "assert-resolve-produced-something"),
      stepByName(doc, "assert-artist-map-floor"),
    ]
  ) {
    const message = (step.task as AssertTask).message;
    assert(
      message.includes(`instance "${hpSite}"`),
      `step "${step.name}"'s message must name the instance the resolve ` +
        `step passes, instance "${hpSite}"`,
    );
    assert(
      message.includes(
        `modelName == "${hpSite}" && specName == "artists" && isLatest`,
      ),
      `step "${step.name}"'s message must carry a runnable query naming ` +
        `instance "${hpSite}"`,
    );
  }
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
