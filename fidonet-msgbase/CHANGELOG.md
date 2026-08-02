# Changelog

## 2026.08.02.1

Real fix for all 9 latent bugs found and pinned by the prior test backfill
(below) -- source edits in `extensions/models/fidonet_msgbase.ts`, not just
characterization. Valid-message parsing stays byte-identical; the only schema
change is an additive, optional `warnings` field on the `messages` resource.

- **LB1 (HIGH) -- `readArea` path traversal via the `area` arg**: added
  `resolveAreaFile(basePath, area, ext)`, adapted from livejournal-import's
  `normalizeSegments` confinement check, used for all three `.jhr`/`.jdt`/
  `.sqd` path builds in `readArea`. Rejects any `/`, `\`, `..`, absolute, `.`,
  or empty area segment with `Area '<x>': path traversal rejected`, and
  double-checks the resolved path still lands under `basePath`. Only `readArea`
  was a vector -- the fan-out search methods enumerate area files via
  `Deno.readDir`, never from a caller-supplied name.
- **LB2 (MED) -- Squish frame-chain cycle**: `parseSquishMessages` now tracks
  visited frame offsets in a `Set` (plus an iteration cap) and breaks on a
  revisit instead of looping forever on a crafted `A -> B -> A` chain.
- **LB3 (MED) -- silent-skip empty catch blocks**: `searchBySender`/
  `searchByAddress`/`searchByText`'s per-area catches, and a too-short (<
  1024-byte) `.jhr` fixed header, now push a message onto a new
  `warnings: string[]` array on the written resource instead of failing
  completely silently; a good sibling area is still fully searched.
- **LB4 (MED) -- `searchByText` excluded all Squish areas**: added a `.sqd`
  branch mirroring `searchBySender`'s, so text that exists only in a Squish area
  is now found.
- **LB5 (LOW) -- `searchByText` dropped JAM areas missing `.jdt`**: a missing
  `.jdt` now sets an empty body and keeps scanning subject/from, matching
  `readArea`/`searchBySender`'s tolerance, instead of `continue`-ing past the
  whole area.
- **LB6 (LOW) -- Squish truncated-frame OOB reads**: `parseSquishMessages` now
  checks `xmsgOfs + 238 <= sqd.length` before reading the XMSG region and skips
  (breaks on) a frame that doesn't have the full fixed region present, instead
  of decoding out-of-bounds `undefined` reads as a garbage `"0:0/0"` address.
- **LB7 (LOW) -- resource-name slug collision**: `searchBySender`/
  `searchByAddress`/`searchByText` now append a 6-hex-digit FNV-1a hash of the
  RAW (pre-slugification) query to their `writeResource` instance name, so
  distinct queries that previously collapsed to the identical slug (e.g.
  `"John.Doe"` vs `"John_Doe"`) no longer overwrite each other's stored results,
  while the same raw query still produces a deterministic name.
  `readArea`/`readNetmail`/`formatForObsidian` instance names are unchanged.
- **LB8 (LOW) -- JAM subfields carried raw untrimmed bytes**: subfield text is
  now NUL-trimmed (`.replace(/\0.*/s, "")`) to match Squish's XMSG fixed fields
  and FTS-0001's header fields. Also collapsed `decodeText`'s dead-code
  high-byte guard (`if (slice.some(b=>b>=0x80)) return text; return text;`) to a
  single `return text;` -- byte-identical, since both branches always returned
  the same value.
- **LB9 (LOW) -- unbounded `Deno.readFile` into RAM**: added
  `readFileCapped(path)`, which `Deno.stat`s a file and rejects it before
  reading if it exceeds a cap (default 256 MiB, overridable via the
  `FIDONET_MSGBASE_MAX_BYTES` env var); used at every `Deno.readFile` call site.
  `readArea` throws `exceeds size cap`; the fan-out search methods surface it as
  a `warnings` entry instead of dropping the area silently.
- Added the model's first `upgrades[]` entry (`2026.07.16.2` -> `2026.08.02.1`,
  identity `upgradeAttributes`) -- no breaking schema change.
- `deno.json`: both `test` and `test:soak` tasks' `--allow-env` extended from
  `FC_NUM_RUNS` to `FC_NUM_RUNS,FIDONET_MSGBASE_MAX_BYTES`.
- `quality.yaml`: re-stamped `ratchet` from a fresh
  `swamp extension quality manifest.yaml --json` run; header comment updated
  from "byte-frozen backfill" to "real-fix".
- Test suites gained 9 new tests (pin-flips plus new adversarial/contract/
  property coverage for the fixes above) -- 59 tests before this change, 68
  after; see the test-backfill bullets below for the suites themselves.

Also folded into this release, the STANDARD.md five-suite quality-bar test
backfill that found and pinned the 9 bugs above (wave-4 batch-4a
extension-quality backfill, `ext-quality-test-backfill`):

- Added `extensions/models/fidonet_msgbase_methods_test.ts` (methods, 9 tests),
  `fidonet_msgbase_contract_test.ts` (contract-fixture, 15 tests),
  `fidonet_msgbase_adversarial_test.ts` (adversarial, 14 tests),
  `fidonet_msgbase_coverage_test.ts` (coverage, 14 tests), and
  `fidonet_msgbase_property_test.ts` (property-invariant-flow, 7 tests) -- 0
  tests before this change, 59 after (68 after the real-fix pass above).
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
- 9 latent bugs were characterized by this backfill's adversarial/coverage
  suites, tracked in the LOCAL `fidonet-msgbase-latent-bugs` issue-lifecycle
  model (NEVER filed to the swamp.club Lab), and real-fixed in the
  `2026.08.02.1` entry above:
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
  measured `swamp extension quality manifest.yaml --json` score at the time:
  `100` / `"Grade A"` (re-measured and re-stamped as part of `2026.08.02.1`
  above). Removed from `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: read-only FidoNet JAM/Squish/FTS-0001 message base reader --
list areas, read an area or netmail, and search all areas by sender, FidoNet
address, or free text. CP866/UTF-8 text decoding with automatic fallback;
origin-line and node/point address extraction; Obsidian markdown export via
`formatForObsidian`.
