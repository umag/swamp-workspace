// RED-phase tests for the fabric's opt-in outputFormat=json (issue
// gobrr-observability). The submit task gains an optional outputFormat; in JSON
// mode the worker runs `claude --print --output-format json` WITHOUT the 2>&1
// stderr-merge and WITHOUT the ERROR-prefix (which would corrupt the JSON), and
// surfaces the exit code out-of-band. The DEFAULT (text) path is unchanged so an
// older consumer / pre-feature run behaves byte-identically.
// Run: /home/zeroclaw/.swamp/deno/deno test extensions/models/firecracker_outputformat.test.ts
import { AGENT_SCRIPT, buildQueuePayload } from "./firecracker.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) {
    throw new Error(`${msg}: expected ${String(b)}, got ${String(a)}`);
  }
}

Deno.test("buildQueuePayload default path is unchanged: prompt/model/effort/gitRepoUrl/id preserved, outputFormat falls back to text", () => {
  const p = buildQueuePayload(
    { prompt: "hi", model: "m", effort: "low", gitRepoUrl: "" },
    "id1",
  ) as Record<string, unknown>;
  // pre-feature fields are byte-identical
  eq(p.id, "id1", "id");
  eq(p.prompt, "hi", "prompt");
  eq(p.model, "m", "model");
  eq(p.effort, "low", "effort");
  eq(p.gitRepoUrl, "", "gitRepoUrl");
  // a default-mode payload must route the worker to the TEXT branch
  assert(
    p.outputFormat === undefined || p.outputFormat === "" ||
      p.outputFormat === "text",
    `default outputFormat must be text-equivalent, got ${
      String(p.outputFormat)
    }`,
  );
});

Deno.test("buildQueuePayload carries outputFormat=json when requested", () => {
  const p = buildQueuePayload(
    { prompt: "hi", outputFormat: "json" },
    "id1",
  ) as Record<string, unknown>;
  eq(p.outputFormat, "json", "outputFormat");
});

Deno.test("AGENT_SCRIPT preserves the text-mode claude --print invocation (default path unchanged)", () => {
  assert(
    /claude --print/.test(AGENT_SCRIPT),
    "text-mode claude --print must remain",
  );
});

Deno.test("AGENT_SCRIPT adds a json branch using --output-format json guarded by OUTPUT_FORMAT", () => {
  assert(
    /--output-format\s+json/.test(AGENT_SCRIPT),
    "runner must support claude --print --output-format json",
  );
  assert(
    /OUTPUT_FORMAT/.test(AGENT_SCRIPT),
    "runner must read an OUTPUT_FORMAT field",
  );
});

Deno.test("AGENT_SCRIPT json region does NOT merge stderr (no 2>&1) — JSON must stay valid", () => {
  // window from the json flag forward; the json capture must not contain 2>&1
  const idx = AGENT_SCRIPT.indexOf("--output-format json");
  assert(idx !== -1, "json branch not found");
  const window = AGENT_SCRIPT.slice(idx, idx + 400);
  assert(
    !/2>&1/.test(window),
    "json-mode capture must not merge stderr (2>&1 corrupts the JSON)",
  );
});
