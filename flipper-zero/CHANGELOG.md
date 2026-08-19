# Changelog

## 2026.08.19.1

- Version bump and smoke test

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4c of the
extension-quality program, `ext-quality-bf-flipper-zero`). No behavior change —
`flipper_zero.ts`, `lib/serial.ts`, `lib/rpc.ts`, `lib/protocol.ts`,
`lib/image.ts` and `bots/snake_bot.ts` are all byte-frozen and the model
`version` stays `2026.07.24.1`.

- Re-homed the two existing test files to their honest `contract-fixture` role:
  `extensions/models/flipper_zero_test.ts` (pure CLI-protocol contract) and
  `extensions/models/lib/image_test.ts` (known-good RPC wire bytes + framebuffer
  round-trips).
- Added `extensions/models/flipper_zero_methods_test.ts` (methods) — all 16
  methods (`detect`, `info`, `exec`, `storage-list`, `storage-read`, `apps`,
  `installed-apps`, `launch`, `close`, `running`, `screenshot`, `show-image`,
  `play-snake`, `listen`, `transmit`, `reboot`), happy path plus a primary
  failure path each, driven through a dual-shape `Deno.Command` stub (`.spawn()`
  -> `stdin.getWriter()`/`output()`/`kill()` for
  exchange/captureRpc/listenCapture/sequenceCapture/play-snake, and a direct
  `.output()` for listDevNames/sendRpcHold/resolveDenoPath) plus `FakeTime` for
  the `delay()`-driven launch/close paths — 0 tests before this change.
- Added `extensions/models/flipper_zero_adversarial_test.ts` (adversarial) —
  pins seven latent bugs found while characterizing the frozen source
  (findScreenFrame false-lock, cleanResponse last-anchor truncation, uncapped
  streaming reads, HEX extra-token admission, non-CRLF control bytes past
  assertSingleLineCommand, play-snake's assertPortPath bypass, sendRpcHold's
  missing kill backstop) plus the security POSITIVE: no exploitable command
  injection — FZ_PORT/FZ_CMD travel via env only, assertPortPath/assertBaud/
  buildTransmitCommand's ALNUM/IDENT/HEX/DEV_PATH allowlists reject shell
  metacharacters. All seven bugs are tracked in the LOCAL
  `@magistr/issue-lifecycle` model `flipper-zero-latent-bugs` (never the Lab) —
  pinned as accepted, frozen-source behavior, not fixed here.
- Added `extensions/models/flipper_zero_coverage_test.ts` (coverage) — both
  sides of the remaining guards: `selectPort` precedence, `cleanResponse`'s
  three anchor branches, `info`'s empty-attributes vs unknown-command fallback
  triggers, the `exchange` throw ladder (busy / generic failure / no response /
  hard-timeout `timedOut=true`), `launch`'s force-with-nothing- running
  shortcut, `installed-apps`'s empty-tree-and-fallback case, `listen` and
  `transmit`'s remaining source/mode branches, and a stateful multi-call `close`
  idempotency check.
- Added `extensions/models/flipper_zero_property_test.ts` (property-
  invariant-flow) using `npm:fast-check@4.8.0` (honoring `FC_NUM_RUNS`, verified
  green at 5000 runs) — varint/frame length-prefix integrity over a test-local
  byte-wise decoder (domain restricted to avoid `varint`'s 32-bit shift
  truncation), framebuffer page-major round-trip, `framebufferBase64`
  round-trip, `stripAnsi`/`normalizeNewlines` never-throw/never-lengthen, the
  storage/device-info/listen parsers never throwing on arbitrary text,
  `buildTransmitCommand`'s ALNUM/IDENT/HEX shapes never leaking a shell
  metacharacter, and `findScreenFrame` always returning null or exactly 1024
  bytes.
- `deno.json`: `test` task now grants
  `--allow-env=FC_NUM_RUNS,HOME,
  SWAMP_DENO_PATH --allow-read=bots/snake_bot.ts`
  (play-snake's characterization tests read the real bot source and
  resolveDenoPath reads `HOME`/`SWAMP_DENO_PATH`); added `test:soak` for the
  high-count nightly property soak.
- `quality.yaml`: `methods`/`adversarial`/`coverage`/`property-invariant-flow`
  flip from `backlog` to `present`; `docs.changelog` -> present
  (`CHANGELOG.md`); `docs.skill` recorded `na` (flipper-zero bundles no Claude
  skill). Ratchet measured 100% (Grade A) via
  `swamp extension quality
  flipper-zero/manifest.yaml --json`. Removed from
  `quality-allowlist.txt` in the same change.

## 2026.07.24.1

Initial release: USB-serial CLI control (`detect`, `info`, `exec`,
`storage-list`, `storage-read`, `apps`, `installed-apps`, `launch`, `close`,
`running`, `reboot`), RPC screen capture/draw (`screenshot`, `show-image`), an
autonomous Snake-playing bot (`play-snake`), and sub-GHz/IR/RFID/NFC receive and
transmit (`listen`, `transmit`).
