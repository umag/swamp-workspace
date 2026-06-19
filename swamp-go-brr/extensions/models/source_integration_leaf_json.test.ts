// RED-phase tests for source-integration's leaf-JSON handling (issue
// gobrr-observability). When a leaf runs in outputFormat=json, the fabric returns
// claude's `--output-format json` object. source-integration OWNS the untrusted
// parse: size-cap BEFORE parse, is_error/non-zero-exit -> claude_error BEFORE the
// envelope parse (the SINGLE claude_error site for text + json), extract .result
// for the unchanged @@EDIT parse, and validate + return declared usage. Text mode
// is unchanged (graceful degrade for an old fabric).
// Run: /home/zeroclaw/.swamp/deno/deno test extensions/models/source_integration_leaf_json.test.ts
import { extractLeafJson, MAX_ENVELOPE_BYTES } from "./source_integration.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("extractLeafJson: is_error=true maps to claude_error BEFORE any envelope parse", () => {
  const raw = JSON.stringify({
    type: "result",
    is_error: true,
    result: "",
    total_cost_usd: 0,
  });
  const r = extractLeafJson(raw, MAX_ENVELOPE_BYTES);
  assert("failureKind" in r, "expected a failure");
  assert(
    (r as { failureKind: string }).failureKind === "claude_error",
    "is_error must map to claude_error, not envelope_parse",
  );
});

Deno.test("extractLeafJson: oversize JSON is rejected BEFORE parse", () => {
  const huge = JSON.stringify({ result: "x".repeat(MAX_ENVELOPE_BYTES + 10) });
  const r = extractLeafJson(huge, MAX_ENVELOPE_BYTES);
  assert("failureKind" in r, "oversize must fail");
  assert(
    (r as { failureKind: string }).failureKind === "envelope_oversize",
    "oversize -> envelope_oversize",
  );
});

Deno.test("extractLeafJson: valid JSON returns .result text + validated declared usage", () => {
  const raw = JSON.stringify({
    type: "result",
    is_error: false,
    result: "<<<GOBRR:n\n@@EDIT src/a.ts\n...\n@@ENDEDIT\nGOBRR:n>>>",
    total_cost_usd: 0.0123,
    duration_ms: 3900,
    usage: {
      input_tokens: 1200,
      output_tokens: 350,
      cache_read_input_tokens: 0,
    },
  });
  const r = extractLeafJson(raw, MAX_ENVELOPE_BYTES) as {
    result: string;
    usage: Record<string, number>;
  };
  assert("result" in r, "expected success");
  assert(
    r.result.includes("@@EDIT src/a.ts"),
    "must surface the envelope text",
  );
  assert(r.usage.inputTokens === 1200, "input tokens");
  assert(r.usage.outputTokens === 350, "output tokens");
  assert(Math.abs(r.usage.costUsd - 0.0123) < 1e-9, "cost usd");
  assert(r.usage.durationMs === 3900, "duration ms");
});

Deno.test("extractLeafJson: out-of-range numeric usage is dropped, result still extracted", () => {
  // Hand-built JSON so NaN/Infinity reach the parser LITERALLY (JSON.stringify would
  // coerce them to null and never exercise the guard). The impl may either reject the
  // malformed-number payload (typed failure, never a throw) OR parse it and drop the
  // out-of-range value — both are acceptable; a leaked out-of-range value is not.
  const R = "<<<GOBRR:n\\n@@EDIT src/a.ts\\nx\\n@@ENDEDIT\\nGOBRR:n>>>";
  for (const v of ["1e308", "-5", "NaN", "Infinity"]) {
    const raw =
      `{"is_error":false,"result":"${R}","total_cost_usd":${v},"usage":{"input_tokens":5,"output_tokens":5}}`;
    const r = extractLeafJson(raw, MAX_ENVELOPE_BYTES) as
      | { result: string; usage: Record<string, number> | null }
      | { failureKind: string };
    if ("failureKind" in r) continue; // rejected outright — acceptable
    assert("result" in r, "result still extracted despite bad cost");
    if (r.usage && r.usage.costUsd !== undefined) {
      assert(
        Number.isFinite(r.usage.costUsd) && r.usage.costUsd >= 0,
        `out-of-range cost ${v} leaked into usage`,
      );
    }
  }
  // out-of-range TOKEN counts are likewise dropped (not only cost)
  for (const v of ["-1", "NaN", "1e308"]) {
    const raw =
      `{"is_error":false,"result":"${R}","usage":{"input_tokens":${v},"output_tokens":5}}`;
    const r = extractLeafJson(raw, MAX_ENVELOPE_BYTES) as
      | { result: string; usage: Record<string, number> | null }
      | { failureKind: string };
    if ("failureKind" in r) continue;
    if (r.usage && r.usage.inputTokens !== undefined) {
      assert(
        Number.isInteger(r.usage.inputTokens) && r.usage.inputTokens >= 0,
        `out-of-range input_tokens ${v} leaked`,
      );
    }
  }
});

Deno.test("extractLeafJson: a non-JSON string (old fabric / text mode) maps to claude_error or parse failure, never throws", () => {
  const r = extractLeafJson("just prose, not json", MAX_ENVELOPE_BYTES);
  assert(
    "failureKind" in r,
    "non-JSON input must yield a typed failure, not a throw",
  );
});
