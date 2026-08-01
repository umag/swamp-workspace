# Changelog

## 2026.08.01.1

Real fix for two HIGH latent bugs tracked in the LOCAL `jscad-cad-latent-bugs`
issue-lifecycle model (never a swamp.club Lab issue), previously only
characterized (pinned, not fixed) by the wave-4 batch-4c test backfill below.
`extensions/models/jscad_cad.ts` and
`extensions/models/jscad/script_evaluator.ts` are no longer byte-frozen for
these two findings; `extensions/models/jscad/types.ts` is unchanged.

- **B1 (HIGH) — unrestricted host-filesystem read on the eval subprocess,
  fixed.** The nested `deno run` subprocess's bare `--allow-read` (no path
  scope) is now `--allow-read=<evalPath>`, scoped to the generated eval script's
  own temp file — the only path the loader must touch (module and npm loading is
  loader-privileged and does not consume the runtime `--allow-read` permission;
  the generated eval script performs zero `Deno.read*` calls of its own). Any
  CadScript that attempts to read a sibling or host file (e.g. to exfiltrate it
  via the `output` artifact) is now denied with a `PermissionDenied` error.
  `--allow-write` stays scoped to `outputPath` as before; argv length stays 5.
- **B2 (HIGH) — no subprocess timeout, fixed.** `Deno.Command` now carries
  `signal: AbortSignal.timeout(EVAL_TIMEOUT_MS)` (default 30s, overridable per
  call), and the process is awaited via `await cmd.output()` instead of the
  synchronous `cmd.outputSync()` — a timer can never fire while a synchronous
  call blocks the isolate thread, so the switch to async is what makes the
  timeout real. On abort, `evaluateAndSerialize` throws a clear
  `"CadScript evaluation timed out after Nms"` error before the generic
  non-zero-exit branch, so a hostile or buggy infinite-looping script can no
  longer hold the swamp model lock indefinitely.
  `ScriptEvaluator.evaluateAndSerialize` is now `async` (an optional `timeoutMs`
  parameter was added); `jscad_cad.ts`'s `run` method now awaits it.
- New live (real-subprocess) negatives in
  `extensions/models/jscad/script_evaluator_test.ts` — the SOLE suite allowed to
  spawn a real `deno` subprocess — prove both fixes against real permissions and
  a real wall-clock bound: a malicious CadScript reading a sibling
  SYNTHETIC-secret temp file is denied and the token never reaches the error
  message; an infinite-looping CadScript run with a short `timeoutMs` times out
  instead of hanging.
- Test suites updated to match: the B1 argv-scope assertions in
  `jscad_cad_adversarial_test.ts`, `jscad_cad_contract_test.ts`, and
  `jscad_cad_property_test.ts` now require the scoped `--allow-read=` token
  (previously pinned the bare unscoped flag); the B2 signal assertion in
  `jscad_cad_adversarial_test.ts` now requires a real `AbortSignal` (previously
  pinned `undefined`). The B2 sync-to-async signature change rippled every
  `FakeCommand` stub across the five suites to add a thin
  `output() { return Promise.resolve(this.outputSync()) }` wrapper, and every
  direct `evaluateAndSerialize` call site is now awaited inside an async test
  body (property tests use `fc.asyncProperty` + `await fc.assert(...)`).
- B3 (MEDIUM), B4/B5 (LOW), and the N3 scanner-evasion root-cause observation
  remain open — out of scope for this fix, still tracked in
  `jscad-cad-latent-bugs`.
- `quality.yaml`'s ratchet stays **UNSCORABLE** baseline-0 as-is; the
  template-literal `import * as serializer from "${pkg}";` (script_evaluator.ts,
  in `buildEvalScript`) is untouched — that scorer misread is a separate
  swamp-PRODUCT bug (`workspace-ratchet-scorer-blockers`), not fixed here.

Also folds in the wave-4 batch-4c test backfill (`ext-quality-test-backfill`)
that preceded this fix and was previously recorded under an `Unreleased` heading
with no version bump — that backfill's own changes were behavior- preserving
(byte-frozen characterization only); the version bump above is for the B1/B2 fix
layered on top of it, not for the backfill itself:

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
- Originally pinned 8 latent findings, characterized rather than fixed, as filed
  against the LOCAL `jscad-cad-latent-bugs` issue-lifecycle model (never the
  Lab). B1 and B2 are now FIXED — see above; both entries are kept below for the
  historical record of what the backfill found:
  1. **B1 — unrestricted host-filesystem read on the eval subprocess (HIGH, now
     FIXED — see above)** — the nested `deno run` subprocess was granted a bare
     `--allow-read` (no path scope) alongside a correctly-scoped
     `--allow-write=<outputPath>`; combined with N3 below, any CadScript could
     read any file the process could access and exfiltrate it via the `output`
     artifact. Originally pinned via argv inspection only.
  2. **B2 — no subprocess timeout (HIGH, now FIXED — see above)** —
     `Deno.Command`'s options carried no `signal`/timeout and `cmd.outputSync()`
     blocked indefinitely if the user's script hung. Originally pinned
     structurally; no test simulated a real hang.
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
