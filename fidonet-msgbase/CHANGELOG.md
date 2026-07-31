# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4a
extension-quality backfill, `ext-quality-test-backfill`). No behavior change --
`extensions/models/fidonet_msgbase.ts` and `manifest.yaml` are BYTE-FROZEN and
the model `version` stays `2026.07.16.2`.

- Added `extensions/models/fidonet_msgbase_methods_test.ts` (methods, 9 tests),
  `fidonet_msgbase_contract_test.ts` (contract-fixture, 15 tests),
  `fidonet_msgbase_adversarial_test.ts` (adversarial, 14 tests),
  `fidonet_msgbase_coverage_test.ts` (coverage, 14 tests), and
  `fidonet_msgbase_property_test.ts` (property-invariant-flow, 7 tests) -- 0
  tests before this change, 59 after.
- Added `extensions/models/fixtures/builders.ts` -- a byte-accurate synthetic
  fixture Factory that is the inverse of the shipped parsers: constructs JAM
  (`.jhr` fixed 1024-byte header + message headers with subfields loID 0/2/3/6,
  plus `.jdt` text), Squish (`.sqd` 256-byte area header + SQHDR frames id
  `0xafae4453` + XMSG), and FTS-0001 (`.msg` 190-byte header + null-terminated
  kludge/body text) buffers via `DataView`. Also added
  `extensions/models/fixtures/PROVENANCE.md` declaring the synthetic-only
  provenance (invented FTN addresses, generic placeholder names, no real
  message-base bytes anywhere).
- Every suite imports `{ model }` and drives
  `model.methods.<m>.execute(args, ctx)` against a fake context (`globalArgs`
  - `writeResource` capturing payloads + `readResource` serving seeded results)
    with `globalArgs.basePath` pointing at a per-test `Deno.makeTempDir()`
    populated by `builders.ts` -- REAL `Deno.readFile`/`Deno.readDir` over the
    byte-accurate fixture bytes, no FS stubbing anywhere.
- 9 already-shipped latent bugs are PINNED (characterized as CURRENT behavior,
  not fixed) and tracked in the LOCAL `fidonet-msgbase-latent-bugs`
  issue-lifecycle model (NEVER filed to the swamp.club Lab):
  1. **`readArea` path/directory traversal via the `area` arg (HIGH)** --
     `${basePath}/${area}.jhr|.jdt|.sqd` is built by direct string interpolation
     with no sanitization; `area="../secret"` escapes `basePath` and reads any
     sibling `.jhr`/`.jdt`/`.sqd` file the process can reach.
  2. **Squish frame-chain has no cycle guard (MEDIUM)** -- `parseSquishMessages`
     follows `nextFrame` with no visited-set; a crafted `A -> B -> A` cycle
     hangs the method forever. Characterized STRUCTURALLY only (the adversarial
     suite proves the byte layout forms a genuine cycle) -- deliberately never
     executed, since running it would hang CI.
  3. **Silent-skip empty catch blocks (MEDIUM)** -- a truncated/corrupt JAM area
     beside a good one contributes zero matches and never blocks search of the
     rest of the msgbase, with no error surfaced anywhere. (Refinement during
     characterization: for `searchBySender`/ `searchByAddress`/`searchByText`'s
     JAM branch, the observable tolerance is actually `parseJamMessages`
     returning `[]` for a too-short area hitting the ordinary
     `if (matches.length===0) continue` -- the outer `catch {}` there is
     unreachable by byte-crafted input alone, since every read in that path is
     bounds-guarded. `readArea`'s own catch IS reachable, because it explicitly
     validates the header and throws.)
  4. **`searchByText` excludes all Squish areas (MEDIUM)** -- it has no `.sqd`
     branch at all (unlike `searchBySender`/`searchByAddress`, which both handle
     Squish); text that exists only in a Squish area returns zero matches.
  5. **`searchByText` drops JAM areas missing `.jdt` (LOW)** -- it does
     `catch { continue; }` on a missing `.jdt`, dropping the WHOLE area (even
     subject/from matches), whereas `readArea` tolerates a missing `.jdt` with
     an empty body.
  6. **Squish truncated-frame OOB reads decode as zero, not NaN (LOW)** --
     bitwise ops coerce out-of-bounds `undefined` reads to `0` via `ToInt32`,
     not `NaN`; a truncated frame yields a degenerate `"0:0/0"` address and a
     rolled-over garbage date (e.g. `1979-11-29`), silently, with no throw.
  7. **Resource-name slug collision (LOW)** -- `searchBySender`/
     `searchByAddress`/`searchByText` build their `writeResource` instance name
     by replacing every non-alphanumeric character with `_`; distinct inputs
     sharing a base and differing only in separator character (e.g. `"John.Doe"`
     vs `"John_Doe"`) collapse to the identical instance name, so the later
     search overwrites the earlier one's data.
  8. **JAM subfields carry raw untrimmed bytes (LOW)** -- a subfield's declared
     `datLen` is taken literally with no NUL-trimming (unlike Squish's XMSG
     fixed fields and FTS-0001's header fields, which both explicitly strip at
     the first NUL via `.replace(/\0.*/, "")` / `.split("\0")[0]`); trailing NUL
     padding survives verbatim into `from`/`to`/`subject`. Paired with
     `decodeText`'s dead-code high-byte guard
     (`if (slice.some(b=>b>=0x80)) return text; return text;` -- both branches
     return the same value).
  9. **Unbounded `Deno.readFile` into RAM (LOW/informational)** -- every parser
     buffers the whole area/text/message file with no size cap or streaming;
     recorded as an accepted informational finding (not exercised with an actual
     multi-GB fixture).
- `deno.json`: `test` task scoped to
  `--allow-read --allow-write --allow-env=FC_NUM_RUNS` (read+write for the
  `Deno.makeTempDir()` fixture trees; no `--allow-net` -- this extension has
  none); `check` task extended to also typecheck
  `extensions/models/fixtures/builders.ts`; added `test:soak` for the high-count
  nightly property soak. `deno.lock` regenerated to lock the new TEST-ONLY dev
  dependencies (`jsr:@std/assert@1`, `npm:fast-check@4.8.0`) -- the source
  dependency (`npm:zod@4`) is unchanged.
- `quality.yaml`: all five required suites flip from `backlog` to `present`;
  `docs.readme`/`docs.changelog` flip to `present`; `docs.skill` recorded `na`
  (fidonet-msgbase bundles no Claude skill -- a filesystem importer, nothing to
  document as a skill). `watch`/`canary` stay `backlog` (seeded offender at
  CI-gate rollout, tracked in `ext-quality-test-backfill`). `ratchet` set to the
  measured `swamp extension quality manifest.yaml --json` score: `100` /
  `"Grade A"`. Removed from `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: read-only FidoNet JAM/Squish/FTS-0001 message base reader --
list areas, read an area or netmail, and search all areas by sender, FidoNet
address, or free text. CP866/UTF-8 text decoding with automatic fallback;
origin-line and node/point address extraction; Obsidian markdown export via
`formatForObsidian`.
