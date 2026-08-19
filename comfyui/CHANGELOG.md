# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.12.13

Adds a **MiniMax H3 reference-to-video** pipeline as a third bundled template,
then builds it out to long-form video, clothes/style transfer and a node-aware
speed stack. This ships the work developed as `2026.08.11.1` through
`2026.08.12.13`; those intermediate versions were never published, so this is
one registry release covering the whole arc.

`manifest.yaml` had been left at `2026.08.12.8` while the model's own `version`
and its `upgrades[]` chain had moved on to `2026.08.12.13` — the last five bumps
never reached the manifest. The manifest now matches the model, which is the
source of truth for what the code actually is.

### Added

- **`minimax_h3` template** — plain-text prompt plus one or two references to an
  mp4, from a bundled API-format graph (`workflows/minimax_h3_r2v.api.json`)
  whose node classes the contract suite pins.
- **Video references.** `buildReferences()` injects one loader per reference:
  `LoadImage` for stills, `LoadVideo` → `GetVideoComponents` for video (frames →
  `ref_videos`, audio → `ref_video_audios`). New `refVideo`/`refVideos`; local
  paths upload via `/upload/image`.
- **`generate_long`** — a `totalDuration` video built from `fragmentDuration`
  (default 5s) clips: slice the reference video into per-fragment windows,
  render each carrying the previous fragment forward, ffmpeg-stitch the result.
  Every `generate` option applies per fragment. New `long` resource; `generate`
  and each fragment now share one `renderClip()`.
- **`ref2i`** — clothes/style transfer onto a still: drives the reference graph
  with `styleImage` (garment → `<Picture 1>`) and `targetImage` (person →
  `<Picture 2>`), renders the shortest clip and saves frame 0 as a PNG. The
  default caption keeps face, pose and background and replaces only the outfit.
- **Speed patcher chain.** `chainModelPatchers()` splices MODEL→MODEL patchers
  between the `UNETLoader` and the sampler; the template declares the registry
  in recommended order and reads every schema live from `/object_info`. Applied
  by default when `speed` is omitted (measured ~43% faster); `speed: []`
  disables it, an explicit list picks a subset.
- **`turbo`** — the 4-step distillation-LoRA fast path (turboLora +
  firstBlockCache + sage + sigmaShift at 8 sampler steps rather than 20).
  Requires the turbo LoRA present in the server's `loras/`. Measured: a 5s
  render in 1m29s against 2m31s.
- **`upscale`** — splices SeedVR2 super-resolution between the decoded frames
  and `CreateVideo` (`upscaleResolution`, default 1080; `upscaleModel`). Errors
  when the SeedVR2 node is absent.
- **`keepRefAudio`** — carries the reference video's own audio instead of the
  generated track. Throws when there is no reference video.
- **`megapixels`** (ResolutionSelector output size), **`unetModel`** (swap the
  diffusion checkpoint on generate/generate_long/ref2i) and **`refImageSize`**
  (`match`|`max`; `max` feeds references at 2048px for markedly stronger
  identity/garment adherence, several times slower).

### Changed

- Speed injection is **node-aware**. An explicit `speed`/`turbo` naming a
  patcher the server lacks now fails with a clear message instead of a raw
  ComfyUI `missing_node_type` 400, while the default stack skips missing
  patchers so a churning node set cannot break a plain render. Adds
  `ComfyClient.fetchInstalledClasses()`.
- `collectFiles()` collects outputs under any key, so `SaveVideo` mp4 output is
  picked up like `SaveImage`; `waitForResult()` keys done/errored off it.

### Fixed

- `generate_long` no longer overwrites its own output: `nextFreePath` takes the
  base name when free, else the next `_2`/`_3` sibling, so runs accumulate.
- Seam jump-cuts between fragments. The continuation carries the previous
  fragment's last ~0.5s forward as a reference VIDEO rather than a frozen still,
  so the model sees subject velocity and camera trajectory at the cut
  (`continuationSeconds: 0` restores the still). Fragment boundaries also snap
  to the lowest-motion frame within `seamWindow` of nominal, so cuts land on
  held poses instead of mid-turn, and the continuation caption binds
  head/face/gaze orientation to `<Video 2>`.

## 2026.08.02.1

Real-fixes the four latent bugs the adversarial suite characterized in the prior
test-backfill release, bumps the model `version` `2026.07.21.1` ->
`2026.08.02.1` with an identity `upgrades[]` entry (no `globalArguments` or
resource-schema change), and flips the four bug pins in
`comfyui_adversarial_test.ts` from asserting the buggy output to asserting the
corrected output.

- **Fix 1 (MED):** `generate` no longer records a seed it never applied. A new
  `appliedSeed`
  (`seed !== undefined && seedNodeId !== undefined ? seed :
  undefined`) is
  what gets patched into the graph AND what gets recorded — an explicit `seed`
  with no known `seedNodeId`/`template` is now honestly recorded as `null`
  instead of misrepresenting the render.
- **Fix 2 (MED):** `ComfyClient.waitForResult` now throws
  `ComfyUI render failed for prompt <id> (status: error)` when a history entry
  reports `status_str: "error"` AND produced zero images, instead of treating
  `completed: true` as unconditional success. An errored render that still
  produced at least one image is unaffected and still returns normally.
- **Fix 3 (LOW):** `snapshotServer` (backing both `lookup` and `sync`) now
  checks `res.ok` before `res.json()`, throwing
  `ComfyUI /system_stats failed: <status> <statusText>` on a non-2xx response —
  instead of a raw unmapped `SyntaxError` on a non-JSON 500 body, or silently
  writing `comfyuiVersion: undefined` on a well-formed-but-empty JSON 500 body.
- **Fix 4 (LOW):** `saveImages` now joins `img.subfolder` into the saved path
  (`${outputDir}/${subfolder}/${filename}`, creating the subfolder directory as
  needed) instead of dropping it — two images that share a filename but live in
  different ComfyUI subfolders no longer collide on disk.
- `comfyui_adversarial_test.ts`: flipped the four `pin:` tests (seed-record,
  errored-render, `snapshotServer` x2, `saveImages` subfolder-collision) to
  assert the corrected behavior, and corrected the suite header, which
  previously said `comfyui.ts` was "UNMODIFIED". The multi-image-orphan pin and
  the apiKey-echo pin are unchanged — they document intentionally unfixed
  behavior.
- `lib/comfy_client.test.ts`: added two `waitForResult` tests covering both
  sides of the new `errored && images.length === 0` guard — an errored+
  imageless render rejects, an errored render with at least one image still
  resolves.

### Prior test-backfill (originally shipped as `Unreleased`)

Test backfill to the STANDARD.md five-suite quality bar (wave 2c gap-check child
of the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change to this prior release — `comfyui.ts`, its libs, and the bundled
workflow JSON were byte-frozen at the time; the model `version` stayed
`2026.07.21.1`.

- Gap-checked the 8 pre-existing test files by ROLE (not filename) and mapped
  them into the STANDARD.md suites: `methods` = `base.test.ts` +
  `comfyui.test.ts`; `contract-fixture` = `lib/comfy_client.test.ts`,
  `lib/anthropic.test.ts`, `lib/caption.test.ts`,
  `lib/caption_generated.test.ts`, `lib/ideogram_prompt.test.ts`,
  `lib/workflow_patch.test.ts`.
- Added `extensions/models/comfyui_contract_test.ts` (contract-fixture gap) —
  pins the two bundled workflow assets structurally (the UI-vs-API-format
  gotcha: every node is an object with a string `class_type` + object `inputs`,
  no top-level `nodes`/`links`) plus every `TEMPLATES` node-id/ input-key pin
  (`ideogram` 98:24/98:18/37, `krea` 30:6/30:3/49/30:15/30:22/30:23), plus
  decode-pins of the six synthetic wire fixtures.
- Added `extensions/models/comfyui_methods_test.ts` (methods gap) — `sync`,
  `node_info`, `generate` over a REAL bundled template (the template-reading
  path + auto-seed), `generate`'s 400/`node_errors` surfacing, and
  `generate_caption`'s missing-`apiKey` guard.
- Added `extensions/models/comfyui_adversarial_test.ts` (adversarial, new) —
  hostile/malformed ComfyUI responses (invalid JSON, HTML 502, missing
  `prompt_id`, `/view` 404 — all resolving immediately; the sole
  timeout/hung-server case stays lib-level in `comfy_client.test.ts`), malformed
  caption/bbox input, credential-leak assertions across both the standard
  API-key and Claude Code OAuth-token auth shapes, and a fixtures-secret-scan
  (`sk-ant-api`/`sk-ant-oat` shapes + a high-entropy pattern + a sanity poison
  test). Also PINNED four found bugs at the time (characterized, not yet fixed —
  tracked in the LOCAL `comfyui-latent-bugs` issue-lifecycle model, never filed
  to the Lab). **All four are now FIXED in `2026.08.02.1` above** — the pins
  were flipped to assert the corrected behavior:
  1. `generate` records a seed it never applied when no `seedNodeId`/ `template`
     resolves — `patched` stays the unmodified base graph while the `generation`
     resource still claims the caller's explicit `seed`, misrepresenting what
     was actually rendered.
  2. `ComfyClient.waitForResult` treats `status.completed === true` as done even
     when `status.status_str` indicates an error and no images were produced —
     `generate` then reports an empty success (`images: []`, `paths: []`)
     instead of surfacing an error.
  3. `snapshotServer` (backing both `lookup` and `sync`) never checks `res.ok`
     before `res.json()` — a non-JSON 500 throws a raw, unmapped `SyntaxError`;
     a well-formed-but-`system`-less JSON error body on a 500 is silently
     accepted, writing `comfyuiVersion: undefined`.
  4. `saveImages` joins `outputDir`/`filename` only, ignoring `img.subfolder` —
     two images sharing a filename in different ComfyUI subfolders collide on
     disk; the later write silently overwrites the earlier one.
- Added `extensions/models/comfyui_coverage_test.ts` (coverage, new) — a
  guard-sweep over `loadGraphAndTemplate`'s branches (unknown template, inline
  `workflow` + `template` together, `globalArgs.workflowPath`, and the bare
  default), `applyContentOverrides`'s LoRA-wiring throw and
  `loras[]`-over-`lora` precedence, the seed auto-pick's nullish-vs-falsy edge
  (`seed: 0`), `generate_batch`'s `seeds`-vs-`count` precedence and default-4
  fallback, and a fenced/degenerate-bbox `generate_caption` end-to-end case.
- Added `extensions/models/comfyui_property_test.ts` (property-invariant-flow,
  new) — `fast-check@4.8.0`, `FC_NUM_RUNS`-gated: `validateBBox`'s accept-iff
  predicate, `repairBBox`'s sort/degenerate invariant, a
  `buildCaption`/`serializeCaption` round-trip, `patchWorkflow`'s clone
  invariant, `findNodesByClass`'s numeric-then-lexical sort, `chainLoras`'s
  chain-length/consumer-wiring invariant, `isHexColor`'s charset, and a
  `build_caption` -> `generate` multi-step flow invariant (given the same
  `makeTempDir` + `finally` cleanup as the methods/adversarial suites — the
  plan's residual LOW finding).
- Added `fixtures/` — six synthetic, doc-derived JSON wire fixtures
  (`system_stats`, `prompt_queued`, `prompt_node_errors`, `history_completed`,
  `object_info_resolution`, `generated_caption`) plus `PROVENANCE.md`. No live
  call was made against the `mycomfy` instance and no `anthropic` vault
  credential was read; every value is synthetic and no real generated-image
  bytes exist anywhere in the corpus (image outputs are JSON `ImageRef` metadata
  only).
- `deno.json`: default `test` task drops `-A`, scoped to
  `--allow-read --allow-write --allow-env=FC_NUM_RUNS` (read for module +
  bundled-workflow reads, write for `generate`'s temp-dir, no `--allow-net` —
  the fetch boundary is stubbed); added `test:soak` for the high-count nightly
  property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/
  `docs.changelog`/`docs.skill` flip from `backlog` to `present` (comfyui
  bundles a Claude skill, so `docs.skill` is `present`, not `na`); measured
  ratchet `100` / `"Grade A"`. Removed from `quality-allowlist.txt` in the same
  change.
