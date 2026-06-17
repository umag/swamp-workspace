// CI regression lock for the desired-state WorkOrder framing (issue
// gobrr-desired-state-workorders). These tests pin the contract of the pure
// prompt builder `buildWorkorderPrompt` and the `WORKORDER_FRAMING`
// selected-policy constant: the imperative path stays byte-identical to history,
// the desired-state branch genuinely reframes, neither framing leaks a gate term,
// and the pure fn never re-scrubs. (Authored TDD-first in Phase 4a, where the
// missing exports made the suite RED; it is now GREEN against the extraction.)
//
// Kept in a SIBLING file (not source_integration.test.ts) so it stays self-
// contained; the `extensions/models/` deno test glob runs it in CI.
import {
  buildWorkorderPrompt,
  type PromptFraming,
  WORKORDER_FRAMING,
} from "./source_integration.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const NONCE = "n0nceFraming42";

// A clean WorkOrder fixture — the spec/practices/slices contain NO gate/test
// vocabulary, so any forbidden term that appears must come from the framing
// scaffold itself (the gate-leak invariant under test).
const SPEC = "Add a foo() helper to bar.ts that returns 42.";
const PRACTICES = "Follow DDD; keep the change minimal.";
const ALLOWLIST = ["bar.ts", "baz.ts"];
const SLICES = [
  { rel: "bar.ts", body: "export function existing() {\n  return 1;\n}\n" },
];

function build(
  framing: PromptFraming,
  over: Record<string, unknown> = {},
): string {
  // `framing` LAST so the positional argument always wins over `over`.
  return buildWorkorderPrompt({
    spec: SPEC,
    practices: PRACTICES,
    writeAllowlist: ALLOWLIST,
    scrubbedSlices: SLICES,
    nonce: NONCE,
    ...over,
    framing,
  });
}

// The desired POST-EXTRACTION imperative assembly of the pure fn, frozen here as
// the byte-identity golden. It mirrors today's build_workorder prompt FORMAT but is
// expressed as the pure-fn contract: the fn iterates already-scrubbed `scrubbedSlices`
// and inlines `body` verbatim — it must NOT read files from disk or call scrubSecrets
// (the caller `execute` is the sole scrub/I-O site; the no-re-scrub test below pins
// that). If the extraction drifts the imperative prompt by even one byte, the test
// fails — that is the point.
function goldenImperative(
  spec: string,
  practices: string,
  writeAllowlist: string[],
  scrubbedSlices: { rel: string; body: string }[],
  nonce: string,
): string {
  const parts: string[] = [
    "You are a coding agent in NO-CLONE mode. Apply the requested fixes, then output ONLY a nonce-fenced @@EDIT envelope (no prose outside the fence).",
    "",
    "TASK:",
    spec,
    "",
    practices ? "PRACTICES:\n" + practices + "\n" : "",
    `You may create or modify ONLY these paths: ${
      JSON.stringify(writeAllowlist)
    }`,
    "",
    "CURRENT CONTENT of the existing files you may edit:",
  ];
  for (const s of scrubbedSlices) {
    parts.push(
      `----- BEGIN ${s.rel} -----`,
      s.body,
      `----- END ${s.rel} -----`,
      "",
    );
  }
  parts.push(
    "Emit EXACTLY one fence. Use literal line markers (raw text between markers — newlines/quotes are fine):",
    `<<<GOBRR:${nonce}`,
    "@@EDIT <path>",
    "@@OLD",
    "<exact unique current text>",
    "@@NEW",
    "<replacement>",
    "@@ENDEDIT",
    "@@NEWFILE <path>",
    "<full file content>",
    "@@ENDFILE",
    `GOBRR:${nonce}>>>`,
    "",
    "Rules: @@OLD must be an exact, unique substring of the file's current content. @@NEWFILE for files that do not exist yet. Each marker alone on its own line. No JSON, no prose outside the fence.",
  );
  return parts.join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ── byte-identity: imperative framing must reproduce today's prompt ──────────

Deno.test("buildWorkorderPrompt: imperative framing is byte-identical to the current prompt assembly", () => {
  const got = build("imperative");
  const want = goldenImperative(SPEC, PRACTICES, ALLOWLIST, SLICES, NONCE);
  assert(
    got === want,
    "imperative prompt drifted from the frozen golden (extraction must be behaviour-preserving)",
  );
});

// ── exactly one nonce fence (both framings) ──────────────────────────────────

Deno.test("buildWorkorderPrompt: each framing emits exactly one nonce fence", () => {
  for (const f of ["imperative", "desired-state"] as PromptFraming[]) {
    const p = build(f);
    assert(
      countOccurrences(p, `<<<GOBRR:${NONCE}`) === 1,
      `${f}: expected exactly one fence-open marker`,
    );
    assert(
      countOccurrences(p, `GOBRR:${NONCE}>>>`) === 1,
      `${f}: expected exactly one fence-close marker`,
    );
  }
});

// ── allowlist echoed + each scrubbed slice inlined (both framings) ────────────

Deno.test("buildWorkorderPrompt: echoes the writeAllowlist and inlines each scrubbed slice", () => {
  for (const f of ["imperative", "desired-state"] as PromptFraming[]) {
    const p = build(f);
    assert(
      p.includes(JSON.stringify(ALLOWLIST)),
      `${f}: writeAllowlist not echoed`,
    );
    for (const s of SLICES) {
      assert(
        p.includes(`----- BEGIN ${s.rel} -----`),
        `${f}: missing BEGIN marker for ${s.rel}`,
      );
      assert(p.includes(s.body), `${f}: slice body for ${s.rel} not inlined`);
      assert(
        p.includes(`----- END ${s.rel} -----`),
        `${f}: missing END marker for ${s.rel}`,
      );
    }
  }
});

// ── desired-state scaffold sits ABOVE the file-slice section + actually reframes

Deno.test("buildWorkorderPrompt: desired-state scaffold reframes and precedes the file-slice section", () => {
  const ds = build("desired-state");
  const imp = build("imperative");
  assert(ds !== imp, "desired-state prompt must differ from imperative");
  // The reframing is present (case-insensitive).
  assert(
    /desired[ -]state/i.test(ds),
    "desired-state prompt must name the desired-state framing",
  );
  // Scaffold appears before the first inlined file slice.
  const firstSlice = ds.indexOf("----- BEGIN ");
  const reframe = ds.search(/desired[ -]state/i);
  assert(firstSlice !== -1, "desired-state prompt must still inline slices");
  assert(
    reframe !== -1 && reframe < firstSlice,
    "desired-state scaffold must sit above the file-slice section",
  );
  // ACTUALLY reframes — the imperative recipe verb must be GONE (closes the
  // prefix-only loophole where an impl prepends "desired-state" to the unchanged
  // imperative prompt and passes the looser checks above).
  assert(
    !/Apply the requested fixes/i.test(ds),
    "desired-state must not retain the imperative recipe verb 'Apply the requested fixes'",
  );
  // The opening line itself differs between the framings (the head is reframed,
  // not merely prefixed).
  assert(
    ds.slice(0, ds.indexOf("\n")) !== imp.slice(0, imp.indexOf("\n")),
    "desired-state must reframe the opening instruction line, not prefix it",
  );
  // Imperative framing must NOT carry the desired-state scaffold.
  assert(
    !/desired[ -]state/i.test(imp),
    "imperative framing must not contain the desired-state scaffold",
  );
});

// ── no re-scrub: the pure fn treats slice bodies as already-scrubbed ──────────

Deno.test("buildWorkorderPrompt: pre-scrubbed tokens pass through verbatim (no re-scrub in pure fn)", () => {
  // A caller (execute) is the sole scrub site; the pure fn must NOT re-scrub.
  // These are SYNTHETIC tokens (repo convention; cf. docker_verify.test.ts /
  // gobrr.test.ts) that scrubSecrets DOES match — so if the pure fn wrongly
  // called scrubSecrets, each would be redacted and an assertion below would
  // fail. Multiple patterns (sk-ant / AWS AKIA / GitHub ghp_) catch a
  // partial-scrub impl that copied only some scrubber patterns. A prior
  // [REDACTED] marker must also survive untouched (no double-redaction).
  const tokens = [
    "sk-ant-FRAMINGfake1234567",
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
  ];
  const slices = [
    {
      rel: "secrets.ts",
      body: `const a = "${tokens[0]}";\nconst b = "${tokens[1]}";\n` +
        `const c = "${tokens[2]}";\nconst prev = "[REDACTED]";\n`,
    },
  ];
  for (const f of ["imperative", "desired-state"] as PromptFraming[]) {
    const p = build(f, { scrubbedSlices: slices });
    for (const t of tokens) {
      assert(
        p.includes(t),
        `${f}: pure fn re-scrubbed "${t}" — it must pass already-scrubbed bodies through verbatim`,
      );
    }
    assert(
      p.includes("[REDACTED]"),
      `${f}: pure fn altered a pre-existing [REDACTED] marker`,
    );
  }
});

// ── gate independence: no framing leaks a test/runner/gate mechanism ─────────

Deno.test("buildWorkorderPrompt: neither framing leaks a test/runner/gate term (prompt-hygiene)", () => {
  // Prompt-hygiene only — the real security invariant is that verifyCommand is
  // absent from build_workorder's argument schema. A code leaf is judged by a
  // test it never reads (work-contract TDD ordering); the framing scaffold must
  // not name the gate mechanism, even generically.
  const plainTerms = [
    "deno test",
    "deno check",
    "cargo test",
    "pytest",
    "exitcode",
    "verifycommand",
    "docker run",
    "test runner",
  ];
  for (const f of ["imperative", "desired-state"] as PromptFraming[]) {
    const lower = build(f).toLowerCase();
    for (const t of plainTerms) {
      assert(!lower.includes(t), `${f}: framing leaked forbidden term "${t}"`);
    }
    assert(
      !/\bgate\b/.test(lower),
      `${f}: framing leaked the standalone word "gate"`,
    );
  }
});

// ── inlined content is declared opaque (prompt-injection hygiene) ─────────────

Deno.test("buildWorkorderPrompt: desired-state framing declares BEGIN/END-delimited content opaque", () => {
  // A file slice can legitimately contain @@EDIT / <<<GOBRR markers; the
  // desired-state scaffold must tell the leaf to treat delimited content as
  // opaque data. (The imperative path stays byte-identical to today, so this
  // caveat is added ONLY to the desired-state branch — see the byte-identity
  // test above.)
  const ds = build("desired-state");
  // Couple "opaque" to the delimiter context so an incidental, unrelated use of
  // the word cannot satisfy the invariant.
  assert(
    /opaque/i.test(ds) &&
      /(BEGIN|END|delimit|between the markers)/i.test(ds) &&
      /opaque[\s\S]{0,160}(BEGIN|END|delimit|marker)|(BEGIN|END|delimit|marker)[\s\S]{0,160}opaque/i
        .test(ds),
    "desired-state prompt must declare BEGIN/END-delimited content opaque (in delimiter context)",
  );
});

// ── empty-practices branch: the `practices ? … : ""` slot (practices defaults "") ─

Deno.test("buildWorkorderPrompt: imperative byte-identity holds with empty practices", () => {
  const got = build("imperative", { practices: "" });
  const want = goldenImperative(SPEC, "", ALLOWLIST, SLICES, NONCE);
  assert(
    got === want,
    "empty-practices imperative path drifted (the falsy PRACTICES branch must emit no block)",
  );
});

Deno.test("buildWorkorderPrompt: empty practices emits no PRACTICES block in either framing", () => {
  for (const f of ["imperative", "desired-state"] as PromptFraming[]) {
    assert(
      !build(f, { practices: "" }).includes("PRACTICES:"),
      `${f}: empty practices must not emit a PRACTICES: block`,
    );
    assert(
      build(f).includes("PRACTICES:"),
      `${f}: non-empty practices must emit a PRACTICES: block`,
    );
  }
});

// ── multi-slice insertion order is preserved (both framings) ──────────────────

Deno.test("buildWorkorderPrompt: multiple slices inline in the given order", () => {
  const slices = [
    { rel: "a.ts", body: "AAA\n" },
    { rel: "b.ts", body: "BBB\n" },
  ];
  for (const f of ["imperative", "desired-state"] as PromptFraming[]) {
    const p = build(f, { scrubbedSlices: slices });
    const ia = p.indexOf("----- BEGIN a.ts -----");
    const ib = p.indexOf("----- BEGIN b.ts -----");
    assert(ia !== -1 && ib !== -1, `${f}: both slices must inline`);
    assert(ia < ib, `${f}: slice order must be preserved (a before b)`);
  }
});

// ── zero slices: still a well-formed single-fence prompt, no BEGIN markers ────

Deno.test("buildWorkorderPrompt: zero slices still emits one fence and no BEGIN marker", () => {
  for (const f of ["imperative", "desired-state"] as PromptFraming[]) {
    const p = build(f, { scrubbedSlices: [] });
    assert(
      countOccurrences(p, `<<<GOBRR:${NONCE}`) === 1,
      `${f}: zero-slice prompt must still carry exactly one fence`,
    );
    assert(
      !p.includes("----- BEGIN "),
      `${f}: zero-slice prompt must not emit a BEGIN marker`,
    );
  }
});

// ── default-until-adoption: the shipped constant stays imperative ────────────

Deno.test("WORKORDER_FRAMING defaults to imperative until the eval-gated adoption flip", () => {
  assert(
    WORKORDER_FRAMING === "imperative",
    "WORKORDER_FRAMING must remain 'imperative' until the pilot clears the bar and the human signs off",
  );
});
