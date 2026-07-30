# Fixture provenance

Every JSON file in this directory is **pure doc-derived / hand-authored** —
built from the shapes documented in ComfyUI's `/system_stats`, `/prompt`,
`/history`, and `/object_info` responses (and the Ideogram-4 magic-prompt output
contract in `lib/ideogram_prompt.ts`), never captured from a live call. This
mirrors the `porkbun`/`pihole` precedent (synthetic fixtures, no live capture)
and is a deliberate security decision, not an oversight.

## What was NOT done (explicit prohibition)

A live `mycomfy` (`@magistr/comfyui/instance`) model instance and an `anthropic`
vault **do exist** in this homelab. **Live capture from either is FORBIDDEN**
for this fixture corpus — not "not done this time", but a standing rule for
anyone regenerating these fixtures later:

- No `swamp model method run mycomfy <method>` call was made while authoring
  these fixtures.
- No vault credential (the `anthropic` vault's API key, or any Claude Code OAuth
  token) was read, exported, or otherwise touched.
- No real image was rendered, downloaded, or inspected. Every image reference in
  `history_completed.json` is **JSON metadata only** (`filename` / `subfolder` /
  `type`) — there are no real generated-image bytes anywhere in this corpus, and
  the adversarial suite's `/view` stub returns a 4-byte synthetic `Uint8Array`,
  never a decodable image.
- No real ComfyUI server version, device/VRAM figures, or object-info combo
  values were transcribed from a running instance — `system_stats.json` and
  `object_info_resolution.json` use placeholder values (see below).

The fixtures-secret-scan test in
`../extensions/models/comfyui_adversarial_test.ts` is a **mechanical backstop**,
not the primary control — the primary control is this prohibition plus never
running a live call in the first place.

## Every value is synthetic

- `system_stats.json`: `comfyui_version: "0.0.0-synthetic"`, a placeholder
  Python/PyTorch version string, and a `synthetic-gpu-0` device entry with
  zeroed VRAM figures — none of these describe a real machine.
- `prompt_queued.json` / `history_completed.json`:
  `prompt_id:
  "synthetic-prompt-0001"` — a made-up id, never a real
  ComfyUI-issued one.
- `prompt_node_errors.json`: the `node_errors` shape (missing required input on
  a `CLIPTextEncode` node) is transcribed from ComfyUI's documented `/prompt`
  400 validation-error envelope, with node id `98:24` matching the bundled
  `ideogram` template's caption node — no live validation failure was captured.
- `history_completed.json`: the single output image is `sample.png`, an
  obviously-placeholder filename; it carries no bytes, only the
  `filename`/`subfolder`/`type` reference triple ComfyUI's `/history` endpoint
  returns for a completed render.
- `object_info_resolution.json`: the `ResolutionSelector` combo values (aspect
  ratio strings) are the same human-readable labels already baked into the
  bundled `workflows/*.api.json` templates (e.g.
  `"9:16 (Portrait
  Widescreen)"`) — not read back from a live `/object_info`
  call.
- `generated_caption.json`: a hand-authored example of the Ideogram-4
  magic-prompt output contract (`aspect_ratio` / `high_level_description` /
  `compositional_deconstruction.elements[]` with `[y1,x1,y2,x2]` bboxes),
  written to satisfy `parseGeneratedCaption`'s documented shape — never a real
  Claude API response. `127.0.0.1` (this extension's default `baseUrl`) and
  `sample.png` are the only "realistic-looking" strings in this corpus, and both
  are RFC-flavored placeholders, not observed values.

## Per-file mapping to the documented endpoint / contract

| File                          | Documented shape                                     |
| ----------------------------- | ---------------------------------------------------- |
| `system_stats.json`           | `GET /system_stats` response                         |
| `prompt_queued.json`          | `POST /prompt` 200 success response                  |
| `prompt_node_errors.json`     | `POST /prompt` 400 validation-error response         |
| `history_completed.json`      | `GET /history/<prompt_id>` completed-entry response  |
| `object_info_resolution.json` | `GET /object_info/ResolutionSelector` response       |
| `generated_caption.json`      | Ideogram-4 magic-prompt JSON caption output contract |

## A documented format gotcha this corpus deliberately preserves

ComfyUI ships two distinct JSON shapes for the "same" workflow: the **UI
format** (a `{"nodes": [...], "links": [...]}` graph editor export, keyed by
visual layout) and the **API format** (a flat
`{"<node-id>": {"class_type":
..., "inputs": {...}}}` map, which is what
`/prompt` actually consumes). `comfyui.ts` only ever reads the bundled
`workflows/*.api.json` files, which are API format. `comfyui_contract_test.ts`
pins this structurally (every node is an object with a string `class_type` and
an object `inputs`, and neither bundled file carries a top-level `nodes`/`links`
key) so a future workflow re-export from the ComfyUI UI — which would silently
produce the wrong shape — fails loudly instead of shipping a broken bundle.
