// Opt-in A/B pilot harness for the desired-state-vs-imperative WorkOrder framing
// (issue gobrr-desired-state-workorders). NOT part of `deno task test` — it lives
// outside the extensions/models/ glob on purpose: the live arm is non-deterministic
// (real microVM runs) and is a human-signed-off pilot, never auto-adoption.
//
// This script does the DETERMINISTIC half: it builds BOTH framings' prompts for
// every fixture task via the same pure `buildWorkorderPrompt` the model ships, and
// prints them for inspection / diffing. The live half (submitting each prompt to
// the gobrr fabric and tallying docker-verify exit codes) is the manual step
// described in README.md.
//
//   deno run --allow-read tests/eval/workorder-framing/pilot.ts
//
import { parse } from "jsr:@std/yaml@1";
import {
  buildWorkorderPrompt,
  type PromptFraming,
  WORKORDER_FRAMING,
} from "../../../extensions/models/source_integration.ts";

interface FixtureTask {
  id: string;
  spec: string;
  writeAllowlist: string[];
  slices: { rel: string; body: string }[];
}
interface Fixture {
  leafModel: string;
  leafEffort: string;
  verifyCommand: string;
  tasks: FixtureTask[];
}

const FRAMINGS: PromptFraming[] = ["imperative", "desired-state"];
// A fixed per-task nonce keeps the two framings' prompts diffable; the real loop
// uses a per-invocation high-entropy nonce.
const PILOT_NONCE = "pilotNonce0000";

function buildPair(task: FixtureTask): Record<PromptFraming, string> {
  const out = {} as Record<PromptFraming, string>;
  for (const framing of FRAMINGS) {
    out[framing] = buildWorkorderPrompt({
      spec: task.spec,
      practices: "",
      writeAllowlist: task.writeAllowlist,
      scrubbedSlices: task.slices, // fixture bodies are synthetic + already clean
      nonce: PILOT_NONCE,
      framing,
    });
  }
  return out;
}

if (import.meta.main) {
  const here = new URL("./fixture.yaml", import.meta.url);
  const fixture = parse(await Deno.readTextFile(here)) as Fixture;
  console.log(
    `# pilot: ${fixture.tasks.length} task(s); leafModel=${fixture.leafModel} ` +
      `effort=${fixture.leafEffort}; shipped WORKORDER_FRAMING=${WORKORDER_FRAMING}`,
  );
  for (const task of fixture.tasks) {
    const pair = buildPair(task);
    for (const framing of FRAMINGS) {
      console.log(`\n===== task=${task.id} framing=${framing} =====`);
      console.log(pair[framing]);
    }
  }
}
