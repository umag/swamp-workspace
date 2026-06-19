// Contract tests for the typed `applied` resource result (issue
// si-applied-result-typing). The `applied` resource was `z.record(z.string(),
// z.unknown())` — opaque, so the per-task result shape and the secret-bearing
// `diff` marking were unchecked. These pin the typed `AppliedTaskResultSchema`
// (a z.union of the Success and Failure shapes that apply() actually writes):
// it accepts both real shapes, rejects malformed/ambiguous ones, requires the
// host-observed `changedPaths` on success, requires a `note` on failure, and
// marks the success `diff` field sensitive.
//
// Authored TDD-first in Phase 4a — the missing exports make this suite RED until
// the union lands. Kept in a SIBLING file (like source_integration_framing.test.ts)
// so the existing source_integration.test.ts stays green; the `extensions/models/`
// deno test glob runs it in CI.
import {
  AppliedTaskFailureSchema,
  AppliedTaskResultSchema,
  AppliedTaskSuccessSchema,
  model,
} from "./source_integration.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// A valid Success result, byte-for-byte the shape apply() writes at the
// host-observation point: changeId, HOST-OBSERVED changedPaths, scrubbed diff,
// and the AGENT-DECLARED envelope summary (advisory).
const SUCCESS = {
  changeId: "qpvuntsmwlqt",
  changedPaths: ["src/a.ts", "src/b.ts"],
  diff: "diff --git a/src/a.ts b/src/a.ts\n+const x = 2;\n",
  declaredEnvelopeSummary: {
    blockCount: 2,
    declaredTargetPaths: ["src/a.ts", "src/b.ts"],
    declaredEditsPerFile: { "src/a.ts": 1, "src/b.ts": 1 },
  },
};

// A valid Failure result, the shape fail() writes: a FailureKind + a note.
const FAILURE = { failureKind: "envelope_parse", note: "parse" };

Deno.test("AppliedTaskResultSchema accepts a valid success result", () => {
  const r = AppliedTaskResultSchema.safeParse(SUCCESS);
  assert(r.success, "valid success result must parse: " + JSON.stringify(r));
});

Deno.test("AppliedTaskResultSchema accepts a valid failure result", () => {
  const r = AppliedTaskResultSchema.safeParse(FAILURE);
  assert(r.success, "valid failure result must parse: " + JSON.stringify(r));
});

Deno.test("AppliedTaskResultSchema rejects an empty object (union discriminates)", () => {
  // {} matches neither member — proves the schema is not the old z.unknown().
  assert(
    !AppliedTaskResultSchema.safeParse({}).success,
    "{} must be rejected by the union",
  );
});

Deno.test("AppliedTaskResultSchema rejects a success missing host-observed changedPaths", () => {
  // The host field is mandatory on success — a result that only declares paths
  // (declaredEnvelopeSummary) but omits changedPaths is not a valid success.
  const noHost = { ...SUCCESS } as Record<string, unknown>;
  delete noHost.changedPaths;
  assert(
    !AppliedTaskResultSchema.safeParse(noHost).success,
    "success without changedPaths must be rejected",
  );
});

Deno.test("AppliedTaskResultSchema rejects a success with non-array changedPaths", () => {
  const badType = { ...SUCCESS, changedPaths: "src/a.ts" };
  assert(
    !AppliedTaskResultSchema.safeParse(badType).success,
    "changedPaths must be string[]",
  );
});

Deno.test("AppliedTaskResultSchema rejects a success missing changeId", () => {
  // apply() always writes changeId (the host jj change id) on success — required,
  // not optional, so a lazy `changeId: z.string().optional()` impl is rejected.
  const noId = { ...SUCCESS } as Record<string, unknown>;
  delete noId.changeId;
  assert(
    !AppliedTaskResultSchema.safeParse(noId).success,
    "success without changeId must be rejected",
  );
});

Deno.test("AppliedTaskResultSchema rejects a success missing diff", () => {
  const noDiff = { ...SUCCESS } as Record<string, unknown>;
  delete noDiff.diff;
  assert(
    !AppliedTaskResultSchema.safeParse(noDiff).success,
    "success without diff must be rejected",
  );
});

Deno.test("AppliedTaskResultSchema rejects a success missing declaredEnvelopeSummary", () => {
  const noEnv = { ...SUCCESS } as Record<string, unknown>;
  delete noEnv.declaredEnvelopeSummary;
  assert(
    !AppliedTaskResultSchema.safeParse(noEnv).success,
    "success without declaredEnvelopeSummary must be rejected",
  );
});

Deno.test("AppliedTaskFailureSchema requires a non-optional note", () => {
  // fail() always supplies a note; the schema must reject a failure without one.
  assert(
    !AppliedTaskFailureSchema.safeParse({ failureKind: "claude_error" })
      .success,
    "failure without note must be rejected (note is required)",
  );
});

Deno.test("AppliedTaskFailureSchema requires failureKind", () => {
  // A failure with only a note is not a valid failure — failureKind is required,
  // so a lazy `failureKind: ...optional()` impl is rejected.
  assert(
    !AppliedTaskFailureSchema.safeParse({ note: "x" }).success,
    "failure without failureKind must be rejected",
  );
});

Deno.test("AppliedTaskFailureSchema constrains failureKind to the FailureKind enum", () => {
  // The kind must be a real FailureKind, not an arbitrary string — pins the impl
  // to FailureKindEnum rather than z.string().
  assert(
    !AppliedTaskFailureSchema.safeParse({
      failureKind: "not_a_real_kind",
      note: "x",
    })
      .success,
    "an unknown failureKind value must be rejected",
  );
});

Deno.test("AppliedTaskResultSchema rejects a success+failure hybrid (members are strict)", () => {
  // A result carrying BOTH a success marker (changeId) and failure markers
  // (failureKind/note) must be rejected — otherwise a non-strict success member
  // would swallow the failureKind and silently route a failure as a success.
  const hybrid = { ...SUCCESS, failureKind: "transport", note: "y" };
  assert(
    !AppliedTaskResultSchema.safeParse(hybrid).success,
    "a success+failure hybrid must be rejected",
  );
});

Deno.test("AppliedTaskResultSchema rejects a success with a malformed declaredEnvelopeSummary", () => {
  // declaredEnvelopeSummary must conform to EnvelopeSummarySchema, not z.unknown().
  const badEnv = { ...SUCCESS, declaredEnvelopeSummary: { foo: 1 } };
  assert(
    !AppliedTaskResultSchema.safeParse(badEnv).success,
    "a malformed declaredEnvelopeSummary must be rejected",
  );
});

Deno.test("AppliedTaskSuccessSchema marks the diff field sensitive", () => {
  // Typing the result is what makes this marking possible — diff was previously
  // hidden inside z.unknown(). Pin it so it cannot silently regress.
  const meta = AppliedTaskSuccessSchema.shape.diff.meta();
  assert(
    meta?.sensitive === true,
    "success diff must carry .meta({ sensitive: true }): " +
      JSON.stringify(meta),
  );
});

Deno.test("applied resource schema rejects an opaque non-result value", () => {
  // The model's `applied` resource schema must no longer accept arbitrary values
  // under a taskId key — it is now z.record(string, AppliedTaskResultSchema).
  // deno-lint-ignore no-explicit-any
  const appliedSchema = (model as any).resources.applied.schema;
  const ok = appliedSchema.safeParse({ results: { t1: SUCCESS, t2: FAILURE } });
  assert(
    ok.success,
    "well-formed results map must parse: " + JSON.stringify(ok),
  );
  const bad = appliedSchema.safeParse({ results: { t1: { junk: true } } });
  assert(!bad.success, "a non-result value under a taskId must be rejected");
});
