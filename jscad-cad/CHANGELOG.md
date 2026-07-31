# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4c of the
extension-quality backfill program, `ext-quality-test-backfill`). No behavior
change — `extensions/models/jscad_cad.ts`,
`extensions/models/jscad/script_evaluator.ts`, and
`extensions/models/jscad/types.ts` are BYTE-FROZEN; the model `version` stays
`2026.07.16.2` and `manifest.yaml` is unchanged (no version bump).

- Added `extensions/models/jscad/jscad_cad_contract_test.ts` (joins the
  contract-fixture role alongside the two existing files below),
  `jscad_cad_methods_test.ts` (methods), `jscad_cad_adversarial_test.ts`
  (adversarial), `jscad_cad_coverage_test.ts` (coverage),
  `jscad_cad_property_test.ts` (property-invariant-flow). Kept
  `extensions/models/jscad/script_evaluator_test.ts` (a LIVE deno-subprocess +
  npm-network integration suite — the SOLE e2e pin, unchanged) and
  `extensions/models/jscad/types_test.ts` as the rest of the contract-fixture
  role.
- Every NEW suite drives `ScriptEvaluator.evaluateAndSerialize` and/or
  `model.methods.run.execute()` against a stubbed `globalThis.Deno.Command`
  (installed via `(globalThis as any).Deno.Command =`, restored in a `finally`,
  per the deno 2.8.3 toolchain rule — never a `as typeof Deno.Command` cast).
  The fake parses argv to recover the generated eval-script path (read back with
  the REAL `Deno.readTextFileSync`, for contract/argv assertions) and the output
  path (from the `--allow-write=<path>` argv token), then writes canned bytes
  via the REAL `Deno.writeFileSync`/`writeTextFileSync` so the real
  `Deno.readFileSync(outputPath)` downstream succeeds. No new test spawns a real
  subprocess, hits the network, or hangs.
- `jscad_cad_property_test.ts` pins parameter round-trip/defensive-copy, format
  → serializer-package/argv well-formedness, JSON.stringify-embedding (no
  injection/breakout), and `stripMarkdownFences` idempotence, using
  `npm:fast-check@4.8.0` (pinned exactly, per CLAUDE.md Rule 7) gated by
  `FC_NUM_RUNS`. Arbitraries are restricted to canonical, JSON-safe subsets;
  verified once at `FC_NUM_RUNS=5000` for flake-freedom before landing at the CI
  default.
- Pinned 8 latent findings, characterized rather than fixed. Filed against the
  LOCAL `jscad-cad-latent-bugs` issue-lifecycle model (never the Lab):
  1. **B1 — unrestricted host-filesystem read on the eval subprocess (HIGH)** —
     the nested `deno run` subprocess is granted a bare `--allow-read` (no path
     scope) alongside a correctly-scoped `--allow-write=<outputPath>`; combined
     with N3 below, any CadScript can read any file the process can access and
     exfiltrate it via the `output` artifact. Pinned via argv inspection only.
  2. **B2 — no subprocess timeout (HIGH)** — `Deno.Command`'s options carry no
     `signal`/timeout; `cmd.outputSync()` blocks indefinitely if the user's
     script hangs. Pinned structurally; no test simulates a real hang.
  3. **B3 — user stdout corrupts the objectCount JSON.parse (MEDIUM)** — the
     subprocess's one stdout stream carries both its own trailing
     `console.log(JSON.stringify({objectCount}))` and anything the user's script
     itself logs; an interleaved `console.log` turns a successful render into a
     `SyntaxError`.
  4. **B4 — silent empty-geometry `objectCount: 0` (LOW)** — a `main()`
     returning `[]` slides through cleanly; `buildEvalScript` re-implements
     array-wrapping inline and never calls the `Geometry.of()` value-object
     guard in `types.ts` that would reject an empty array — `Geometry.of` is
     dead code from the real execution path's perspective.
  5. **B5 — unbounded in-memory output (LOW)** — both the binary concatenation
     and the text `parts.join("")` are uncapped. Pinned structurally (no
     oversized fixture is ever allocated).
  6. **N3 — Function-constructor scanner evasion (root cause of B1)** — the eval
     script obtains `Function` via `globalThis["Func" + "tion"]` (string-split +
     bracket lookup) specifically to dodge static scanners that grep the literal
     `"new Function"`. This is the SAME class of naive-scanner blind spot as the
     quality-scorer's own bare-import false positive (see ratchet, below).
  - Covered negatives (verified to currently hold): **N1** no shell/argv
    command-injection surface (plain argv array; user content only ever appears
    JSON.stringify-escaped inside the eval-script file, never as an argv token);
    **N2** no output/eval path traversal (`outputPath`/ `evalPath` come
    exclusively from `Deno.makeTempFileSync`, never from user input).
- `quality.yaml`: all five suites plus `docs.readme`/`docs.changelog`/
  `docs.skill` flip from `backlog` to `present` (`docs.skill` points at the
  already-shipped `.claude/skills/jscad-codegen/SKILL.md`). Ratchet set to
  **UNSCORABLE** (seanime-style):
  `swamp extension quality
  jscad-cad/manifest.yaml --json` errors on
  `script_evaluator.ts`'s template-literal
  `import * as serializer from "${pkg}";` (line 64), which the scorer's static
  import scanner misreads as an unresolvable bare specifier — a scorer bug, not
  a real bare import; the source is byte-frozen so it cannot be worked around
  here. Tracked in `jscad-cad-latent-bugs` +
  `workspace-ratchet-scorer-blockers`. Removed from `quality-allowlist.txt` in
  the same change.

## 2026.07.16.2

Initial release: JSCAD v2 CAD renderer — evaluate a CadScript's `main(params)`
in a sandboxed `deno` subprocess and serialize the resulting geometry to
`STL`/`STL-ASCII`/`DXF`/`SVG`/`OBJ`/`3MF`. Ships the **jscad-codegen** Claude
Code skill for authoring correct JSCAD v2 scripts.
